FROM node:20-alpine

WORKDIR /app

# Add dependencies
COPY package.json package-lock.json* yarn.lock* pnpm-lock.yaml* bun.lockb* ./
RUN npm install

# Copy source
COPY . .

# Build
RUN npm run build

# Start the app
EXPOSE 3000
ENV HOST=0.0.0.0
ENV PORT=3000
CMD ["node", ".output/server/index.mjs"]
