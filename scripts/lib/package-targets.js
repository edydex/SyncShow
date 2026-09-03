'use strict';

const PACKAGE_TARGETS = Object.freeze({
  'darwin-arm64': Object.freeze({
    canvasPackage: 'canvas-darwin-arm64',
    canvasBinary: 'skia.darwin-arm64.node',
    sharpPackage: 'sharp-darwin-arm64',
    libvipsPackage: 'sharp-libvips-darwin-arm64',
    electronFfmpeg: 'libffmpeg.dylib',
    nativePackageArtifacts: Object.freeze([
      Object.freeze({
        package: '@napi-rs/canvas-darwin-arm64',
        suffix: 'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node'
      }),
      Object.freeze({
        package: '@img/sharp-darwin-arm64',
        suffix: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node'
      }),
      Object.freeze({
        package: '@img/sharp-libvips-darwin-arm64',
        suffix: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib'
      })
    ])
  }),
  'darwin-x64': Object.freeze({
    canvasPackage: 'canvas-darwin-x64',
    canvasBinary: 'skia.darwin-x64.node',
    sharpPackage: 'sharp-darwin-x64',
    libvipsPackage: 'sharp-libvips-darwin-x64',
    electronFfmpeg: 'libffmpeg.dylib',
    nativePackageArtifacts: Object.freeze([
      Object.freeze({
        package: '@napi-rs/canvas-darwin-x64',
        suffix: 'node_modules/@napi-rs/canvas-darwin-x64/skia.darwin-x64.node'
      }),
      Object.freeze({
        package: '@img/sharp-darwin-x64',
        suffix: 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.3.node'
      }),
      Object.freeze({
        package: '@img/sharp-libvips-darwin-x64',
        suffix: 'node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.3.dylib'
      })
    ])
  }),
  'linux-x64': Object.freeze({
    canvasPackage: 'canvas-linux-x64-gnu',
    canvasBinary: 'skia.linux-x64-gnu.node',
    sharpPackage: 'sharp-linux-x64',
    libvipsPackage: 'sharp-libvips-linux-x64',
    electronFfmpeg: 'libffmpeg.so',
    nativePackageArtifacts: Object.freeze([
      Object.freeze({
        package: '@napi-rs/canvas-linux-x64-gnu',
        suffix: 'node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'
      }),
      Object.freeze({
        package: '@img/sharp-linux-x64',
        suffix: 'node_modules/@img/sharp-linux-x64/lib/sharp-linux-x64-0.35.3.node'
      }),
      Object.freeze({
        package: '@img/sharp-libvips-linux-x64',
        suffix: 'node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3'
      })
    ])
  }),
  'win32-x64': Object.freeze({
    canvasPackage: 'canvas-win32-x64-msvc',
    canvasBinary: 'skia.win32-x64-msvc.node',
    sharpPackage: 'sharp-win32-x64',
    libvipsPackage: null,
    electronFfmpeg: 'ffmpeg.dll',
    nativePackageArtifacts: Object.freeze([
      Object.freeze({
        package: '@napi-rs/canvas-win32-x64-msvc',
        suffix: 'node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node'
      }),
      Object.freeze({
        package: '@img/sharp-win32-x64',
        suffix: 'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node'
      }),
      Object.freeze({
        package: '@img/sharp-win32-x64',
        suffix: 'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll'
      }),
      Object.freeze({
        package: '@img/sharp-win32-x64',
        suffix: 'node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.3.dll'
      })
    ])
  })
});

function packageTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  const target = PACKAGE_TARGETS[key];
  if (!target) {
    throw new Error(`Unsupported packaged application target: ${key}.`);
  }
  return {
    key,
    platform,
    arch,
    ...target
  };
}

module.exports = {
  PACKAGE_TARGETS,
  packageTarget
};
