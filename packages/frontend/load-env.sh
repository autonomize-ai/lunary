#!/bin/bash
# This script is necessary because we need to be able to inject API_URL after build time, and Next does not provide and easy way to do that.
# This should work find both with npm run dev, locally and with docker

# Loads .env
if [ -f .env ]; then
  set -o allexport
  source .env 
  set +o allexport
fi

# Check if API_URL is set, if not, exit with an error
if [ -z "$API_URL" ]; then
    echo "Error: API_URL not set. Please set the API_URL environment variables."
    exit 1
fi

# Optional: Additional environment variable checks or setup
echo "API_URL is set to: $API_URL"

LC_ALL=C  find .next -type f -exec perl -pi -e "s|xyzPLACEHOLDERxyz|${API_URL}|g" {} +