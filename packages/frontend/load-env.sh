#!/bin/bash
# This script is necessary because we need to be able to inject API_URL after build time, and Next does not provide an easy way to do that.
# This should work fine both with npm run dev, locally and with docker

# Loads .env
if [ -f .env ]; then
  set -o allexport
  source .env 
  set +o allexport
fi

# Check if API_URL is set, if not, use a default
if [ -z "$API_URL" ]; then
    API_URL="http://lunary-backend:3000"
    echo "Warning: API_URL not set. Using default: $API_URL"
fi

echo "API_URL is set to: $API_URL"

# Use sed instead of perl, which is more universally available
find .next -type f -exec sed -i "s|xyzPLACEHOLDERxyz|${API_URL}|g" {} +