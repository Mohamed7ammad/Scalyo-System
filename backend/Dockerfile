# ── Backend container image (Back4app Containers) ───────────────────────────
FROM node:18-alpine

# App working directory
WORKDIR /app

# Install dependencies first (better layer caching — only re-runs when
# package.json / package-lock.json change).
COPY package*.json ./
RUN npm install --omit=dev

# Copy the rest of the backend source
COPY . .

# The Express server listens on 4000 (see src/index.js: PORT || 4000)
EXPOSE 4000

# Entry point
CMD ["node", "src/index.js"]
