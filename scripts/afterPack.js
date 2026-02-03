// electron-builder afterPack hook to fix Linux sandbox issues
// This modifies the startup script to include --no-sandbox

const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  // Only process Linux builds
  if (context.electronPlatformName !== 'linux') {
    return;
  }

  const appOutDir = context.appOutDir;
  const executableName = context.packager.executableName;
  
  // Create a wrapper script
  const wrapperPath = path.join(appOutDir, executableName);
  const realBinaryPath = path.join(appOutDir, `${executableName}.bin`);
  
  // Check if the executable exists
  if (fs.existsSync(wrapperPath)) {
    // Rename original binary
    fs.renameSync(wrapperPath, realBinaryPath);
    
    // Create wrapper script
    const wrapperScript = `#!/bin/bash
# Wrapper to fix Chrome sandbox issue on Linux
SCRIPT_DIR="$(dirname "$(readlink -f "$0")")"
exec "$SCRIPT_DIR/${executableName}.bin" --no-sandbox "$@"
`;
    
    fs.writeFileSync(wrapperPath, wrapperScript);
    fs.chmodSync(wrapperPath, '755');
    
    console.log(`Created --no-sandbox wrapper for ${executableName}`);
  }
};
