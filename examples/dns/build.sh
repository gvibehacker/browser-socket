#!/bin/bash

# Build Go WASM for DNS lookup
echo "Building DNS WASM module..."

# Set WASM build environment
export GOOS=js
export GOARCH=wasm

# Build the Go program to WASM
go build -ldflags="-s -w" -o dns.wasm dns.go

if [ $? -eq 0 ]; then
    echo "Build successful! Output: dns.wasm"
    
    # Copy wasm_exec.js from Go installation if not present
    if [ ! -f "wasm_exec.js" ]; then
        echo "Copying wasm_exec.js..."
        cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" .
        if [ $? -eq 0 ]; then
            echo "wasm_exec.js copied successfully"
        else
            echo "Warning: Could not copy wasm_exec.js automatically"
            echo "Please copy it manually from: $(go env GOROOT)/misc/wasm/wasm_exec.js"
        fi
    fi
    
    # Check file sizes
    echo ""
    echo "File sizes:"
    ls -lh dns.wasm 2>/dev/null
    
    echo ""
    echo "To run the demo:"
    echo "1. Start a local web server: python3 -m http.server 8000"
    echo "2. Open http://localhost:8000/"
else
    echo "Build failed!"
    exit 1
fi