'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DRIVE_FOLDER_MIME_TYPE,
  GOOGLE_SLIDES_MIME_TYPE,
  GoogleDriveClient,
  GoogleDriveError,
  POWERPOINT_MIME_TYPE,
  refreshGoogleAccessToken
} = require('../src/services/google-drive/GoogleDriveClient');

const API_KEY = 'AIzaSyDUMMY_KEY_FOR_SYNCSHOW_TESTING_123456';
const ROOT_ID = 'rootFolder1234567890';
const CHILD_FOLDER_ID = 'childFolder123456789';
const PPTX_ID = 'pptxFile12345678901';
const SLIDES_ID = 'slidesFile123456789';

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function folder(id, name, resourceKey = null) {
  return {
    id,
    name,
    mimeType: DRIVE_FOLDER_MIME_TYPE,
    resourceKey,
    capabilities: {
      canListChildren: true,
      canAddChildren: true,
      canDownload: false,
      canEdit: true,
      canModifyContent: true
    }
  };
}

function pptx(id, name, resourceKey = null) {
  return {
    id,
    name,
    mimeType: POWERPOINT_MIME_TYPE,
    size: '42',
    modifiedTime: '2026-07-23T12:00:00.000Z',
    md5Checksum: '0123456789abcdef0123456789abcdef',
    resourceKey,
    capabilities: { canDownload: true }
  };
}

test('public Drive listing uses API-key auth, shared-drive flags, pagination, recursion, and resource keys', async () => {
  const requests = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    requests.push({ url, options });
    assert.equal(url.searchParams.get('key'), API_KEY);
    assert.equal(options.headers.Authorization, undefined);

    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(options.headers['X-Goog-Drive-Resource-Keys'], `${ROOT_ID}/root_key`);
      return jsonResponse(folder(ROOT_ID, 'Services', 'root_key'));
    }
    const query = url.searchParams.get('q');
    if (query === `'${ROOT_ID}' in parents and trashed = false`
      && !url.searchParams.get('pageToken')) {
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
      return jsonResponse({
        files: [pptx(PPTX_ID, 'English 07-23-2026.pptx', 'pptx_key')],
        nextPageToken: 'next-page'
      });
    }
    if (query === `'${ROOT_ID}' in parents and trashed = false`
      && url.searchParams.get('pageToken') === 'next-page') {
      return jsonResponse({ files: [folder(CHILD_FOLDER_ID, 'Archive', 'child_key')] });
    }
    if (query === `'${CHILD_FOLDER_ID}' in parents and trashed = false`) {
      assert.equal(
        options.headers['X-Goog-Drive-Resource-Keys'],
        `${CHILD_FOLDER_ID}/child_key`
      );
      return jsonResponse({
        files: [{
          id: SLIDES_ID,
          name: 'Singer/Screen',
          mimeType: GOOGLE_SLIDES_MIME_TYPE,
          modifiedTime: '2026-07-23T12:00:00.000Z',
          capabilities: { canDownload: true }
        }]
      });
    }
    throw new Error(`Unexpected Drive request: ${url}`);
  };

  const client = new GoogleDriveClient({ fetchImpl, apiKey: API_KEY });
  const result = await client.listFolder({
    folderId: ROOT_ID,
    resourceKey: 'root_key',
    maximumDepth: 2
  });

  assert.equal(result.root.name, 'Services');
  assert.equal(result.files.length, 2);
  assert.equal(result.folders.length, 1);
  assert.equal(result.files[0].relativePath, 'English 07-23-2026.pptx');
  assert.equal(result.files[1].relativePath, 'Archive/Singer Screen');
  assert.equal(result.files[1].depth, 1);
  assert.equal(requests.length, 4);
});

test('Drive listing enforces item and page safety caps', async () => {
  const fetchImpl = async input => {
    const url = new URL(input);
    if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
      return jsonResponse(folder(ROOT_ID, 'Services'));
    }
    return jsonResponse({
      files: [pptx(PPTX_ID, 'one.pptx')],
      nextPageToken: 'more'
    });
  };
  const client = new GoogleDriveClient({ fetchImpl, apiKey: API_KEY });
  await assert.rejects(
    client.listFolder({ folderId: ROOT_ID, maximumFiles: 1 }),
    error => error instanceof GoogleDriveError && error.code === 'LIST_LIMIT_EXCEEDED'
  );

  let page = 0;
  const pagingClient = new GoogleDriveClient({
    apiKey: API_KEY,
    fetchImpl: async input => {
      const url = new URL(input);
      if (url.pathname === `/drive/v3/files/${ROOT_ID}`) {
        return jsonResponse(folder(ROOT_ID, 'Services'));
      }
      page += 1;
      return jsonResponse({ files: [], nextPageToken: `page-${page}` });
    }
  });
  await assert.rejects(
    pagingClient.listFolder({ folderId: ROOT_ID, maximumPages: 2 }),
    error => error instanceof GoogleDriveError && error.code === 'PAGE_LIMIT_EXCEEDED'
  );
});

test('Drive 403 rate-limit responses remain retryable rather than looking like permissions failures', async () => {
  const client = new GoogleDriveClient({
    apiKey: API_KEY,
    fetchImpl: async () => jsonResponse({
      error: {
        errors: [{ reason: 'userRateLimitExceeded' }],
        status: 'RESOURCE_EXHAUSTED'
      }
    }, 403)
  });

  await assert.rejects(
    client.getFileMetadata({ fileId: ROOT_ID }),
    error => error instanceof GoogleDriveError
      && error.code === 'RATE_LIMITED'
      && error.retryable === true
      && error.status === 403
  );
});

test('binary download and Slides export are bounded and carry resource keys', async () => {
  const requests = [];
  const client = new GoogleDriveClient({
    accessToken: 'private-access-token-value',
    maximumDownloadBytes: 1024,
    fetchImpl: async (input, options) => {
      const url = new URL(input);
      requests.push({ url, options });
      assert.equal(options.headers.Authorization, 'Bearer private-access-token-value');
      assert.equal(url.searchParams.has('key'), false);
      if (url.pathname.endsWith('/export')) {
        assert.equal(url.searchParams.get('mimeType'), POWERPOINT_MIME_TYPE);
        return new Response(Buffer.from('exported-pptx'));
      }
      assert.equal(url.searchParams.get('alt'), 'media');
      assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
      return new Response(Buffer.from('binary-pptx'));
    }
  });

  const binary = await client.downloadPresentation({
    id: PPTX_ID,
    mimeType: POWERPOINT_MIME_TYPE,
    resourceKey: 'binary_key'
  });
  const exported = await client.downloadPresentation({
    id: SLIDES_ID,
    mimeType: GOOGLE_SLIDES_MIME_TYPE,
    resourceKey: 'slides_key'
  });
  assert.equal(binary.toString(), 'binary-pptx');
  assert.equal(exported.toString(), 'exported-pptx');
  assert.equal(
    requests[0].options.headers['X-Goog-Drive-Resource-Keys'],
    `${PPTX_ID}/binary_key`
  );
  assert.equal(
    requests[1].options.headers['X-Goog-Drive-Resource-Keys'],
    `${SLIDES_ID}/slides_key`
  );

  const oversized = new GoogleDriveClient({
    apiKey: API_KEY,
    fetchImpl: async () => new Response(Buffer.alloc(20), {
      headers: { 'Content-Length': '20' }
    })
  });
  await assert.rejects(
    oversized.downloadFile({ fileId: PPTX_ID, maximumBytes: 10 }),
    error => error.code === 'RESPONSE_TOO_LARGE'
  );
});

test('token refresh remains compatible with a secretless Desktop client', async () => {
  let observedBody = null;
  const result = await refreshGoogleAccessToken({
    clientId: '123456789012-client.apps.googleusercontent.com',
    refreshToken: 'refresh-token-for-testing',
    fetchImpl: async (input, options) => {
      assert.equal(String(input), 'https://oauth2.googleapis.com/token');
      assert.equal(options.method, 'POST');
      observedBody = new URLSearchParams(String(options.body));
      return jsonResponse({
        access_token: 'new-access-token-for-testing',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.file'
      });
    }
  });

  assert.equal(observedBody.get('client_id'), '123456789012-client.apps.googleusercontent.com');
  assert.equal(observedBody.get('refresh_token'), 'refresh-token-for-testing');
  assert.equal(observedBody.get('grant_type'), 'refresh_token');
  assert.equal(observedBody.has('client_secret'), false);
  assert.equal(result.accessToken, 'new-access-token-for-testing');
  assert.equal(result.expiresIn, 3600);
});

test('token refresh sends an optional Desktop client secret only to the token endpoint', async () => {
  const clientSecret = 'GOCSPX-test-desktop-client-credential';
  let observedBody = null;
  const result = await refreshGoogleAccessToken({
    clientId: '123456789012-client.apps.googleusercontent.com',
    clientSecret,
    refreshToken: 'refresh-token-for-testing',
    fetchImpl: async (input, options) => {
      assert.equal(String(input), 'https://oauth2.googleapis.com/token');
      observedBody = new URLSearchParams(String(options.body));
      return jsonResponse({
        access_token: 'new-access-token-for-testing',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/drive.file'
      });
    }
  });

  assert.equal(observedBody.get('client_id'), '123456789012-client.apps.googleusercontent.com');
  assert.equal(observedBody.get('client_secret'), clientSecret);
  assert.equal(observedBody.get('refresh_token'), 'refresh-token-for-testing');
  assert.equal(observedBody.get('grant_type'), 'refresh_token');
  assert.equal(result.accessToken, 'new-access-token-for-testing');
});

test('token refresh rejects malformed optional client secrets before network access', async () => {
  for (const clientSecret of ['short', 'contains space', 'unicode-\u2603', 'x'.repeat(1025)]) {
    let fetchCalled = false;
    await assert.rejects(
      refreshGoogleAccessToken({
        clientId: '123456789012-client.apps.googleusercontent.com',
        clientSecret,
        refreshToken: 'refresh-token-for-testing',
        fetchImpl: async () => {
          fetchCalled = true;
          throw new Error('must not fetch');
        }
      }),
      error => error instanceof TypeError && /client secret is invalid/.test(error.message)
    );
    assert.equal(fetchCalled, false);
  }
});
