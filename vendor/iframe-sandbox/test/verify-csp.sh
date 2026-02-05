#!/bin/bash
# test/verify-csp.sh
# Verifies that the sandbox server applies dynamic CSP headers based on query params.

SERVER_URL="http://sandbox.localhost:3333"

echo "Checking Outer Frame CSP..."
CURL_OUT=$(curl -sI "$SERVER_URL/outer-frame.html?allow=api.foo.com,bar.com")
if echo "$CURL_OUT" | grep -q "connect-src 'self' https://api.foo.com https://bar.com"; then
  echo "✅ Outer Frame: Dynamic CSP applied correctly"
else
  echo "❌ Outer Frame: Dynamic CSP failure"
  echo "$CURL_OUT" | grep "Content-Security-Policy"
fi

echo -e "\nChecking Inner Frame CSP (propagation test)..."
CURL_IN=$(curl -sI "$SERVER_URL/inner-frame.html?allow=api.foo.com,bar.com")
if echo "$CURL_IN" | grep -q "connect-src 'self' https://api.foo.com https://bar.com"; then
  echo "✅ Inner Frame: Dynamic CSP applied correctly"
else
  echo "❌ Inner Frame: Dynamic CSP failure"
  echo "$CURL_IN" | grep "Content-Security-Policy"
fi

echo -e "\nChecking Default CSP (no params)..."
CURL_DEF=$(curl -sI "$SERVER_URL/outer-frame.html")
if echo "$CURL_DEF" | grep -q "connect-src 'self';"; then
  echo "✅ Default: Strict connect-src 'self' applied"
else
  echo "❌ Default: CSP failure"
  echo "$CURL_DEF" | grep "Content-Security-Policy"
fi
