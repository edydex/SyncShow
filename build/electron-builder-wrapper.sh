#!/bin/bash
# Wrapper script to launch Electron with --no-sandbox on Linux
"${BASH_SOURCE%/*}"/../sync-show --no-sandbox "$@"
