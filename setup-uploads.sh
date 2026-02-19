#!/bin/bash

# Setup uploads directory with correct permissions for Docker
# This script should be run on the EC2 instance

set -e

echo "🔧 Setting up uploads directory..."

# Create the uploads directory structure
mkdir -p public/uploads/photos

# Set permissions so the Docker container can write to it
# The nextjs user in the container has UID 1001
# We make the directory writable by everyone (or you can chown to 1001:1001)
chmod -R 777 public/uploads

echo "✅ Uploads directory created with permissions:"
ls -la public/uploads

echo ""
echo "📁 Directory structure:"
tree public/uploads 2>/dev/null || find public/uploads -type d

echo ""
echo "✅ Setup complete! The Docker container can now write photos to:"
echo "   $(pwd)/public/uploads"
echo ""
echo "Note: Uploaded files will persist across container restarts."
