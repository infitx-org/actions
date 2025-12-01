ARG NODE_VERSION_BUILD=24.11.0
ARG NODE_VERSION=24.11.0-slim

# Verify installations
RUN kubectl version --client && \
    helm version && \
    k9s version && \
    squid -v && \
    git --version && \
    jq --version && \
    yq --version && \
    argocd version --client && \
    k6 version && \
    kubescape version

# Build application dependencies
FROM node:${NODE_VERSION_BUILD} AS builder
WORKDIR /opt/app
COPY package*.json ./
RUN npm ci

# Final release image
FROM node:${NODE_VERSION} AS release
RUN mkdir -p /opt/app && chown -R node:node /opt/app
WORKDIR /opt/app
USER node
COPY --chown=node --from=builder /opt/app .
COPY --chown=node **/*.*js .

EXPOSE 8080
ENTRYPOINT [ "node" ]
CMD [ "index.js" ]
