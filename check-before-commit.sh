#!/bin/bash

# Pre-commit check script to catch errors before pushing
# Run this before committing: ./check-before-commit.sh

set -e

echo "🔍 Running pre-commit checks..."
echo ""

# 1. TypeScript check
echo "📘 Checking TypeScript..."
npx tsc --noEmit
echo "✅ TypeScript check passed!"
echo ""

# 2. Lint check
echo "🧹 Running ESLint..."
npm run lint
echo "✅ Lint check passed!"
echo ""

# 3. Build check (catches bundler errors)
echo "🔨 Testing production build..."
npm run build
echo "✅ Build check passed!"
echo ""

echo "✅ All checks passed! Safe to commit and push."
