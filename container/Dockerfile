# Base image for the per-user Executor/Creator container — see the
# architecture writeup for why this runs on the VM rather than as a Cloud
# Function (needs root/shell to install whatever a generated capability's
# dependencies turn out to be; not built yet — see runCode.ts's comments on
# the current "no imports" constraint).
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=builder /app/lib ./lib
ENTRYPOINT ["node", "lib/index.js"]
