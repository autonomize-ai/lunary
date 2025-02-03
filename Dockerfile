# Use an official Node runtime as the base image
FROM node:20-alpine AS base

# Set working directory
WORKDIR /app

# Install global dependencies
RUN npm install -g concurrently tsx

# Copy package.json and package-lock.json
COPY package*.json ./
COPY packages/backend/package*.json ./packages/backend/
COPY packages/frontend/package*.json ./packages/frontend/
COPY packages/shared/package*.json ./packages/shared/

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY . .

# Conditionally build shared packages (if build script exists)
RUN if npm run --workspace=shared --if-present build; then \
        echo "Shared package build completed"; \
    else \
        echo "No build script for shared package, skipping"; \
    fi

# Conditionally build frontend and backend
ARG BUILD_FRONTEND=true
ARG BUILD_BACKEND=true

# Database configuration
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}

RUN if [ "$BUILD_FRONTEND" = "true" ]; then npm run build:frontend; fi
RUN if [ "$BUILD_BACKEND" = "true" ]; then npm run migrate:db -w packages/backend; fi

# Expose ports for backend and frontend
EXPOSE 3000 4000

# Set environment variables for ports
ENV FRONTEND_PORT=3000
ENV BACKEND_PORT=4000

# Conditionally start frontend and/or backend
CMD if [ "$BUILD_FRONTEND" = "true" ] && [ "$BUILD_BACKEND" = "true" ]; then \
        npm run start; \
    elif [ "$BUILD_FRONTEND" = "true" ]; then \
        npm run start:frontend; \
    elif [ "$BUILD_BACKEND" = "true" ]; then \
        npm run start:backend; \
    else \
        echo "No services configured to start"; \
        exit 1; \
    fi