# Bitswan Editor
## Deployment
```yaml
  bitswan-editor:
    image: bitswan/bitswan-editor:2024-11177396408-git-b7f80e5
    restart: always
    ports:
      - "10000:8080"
    entrypoint: ["/usr/bin/entrypoint.sh", "--auth", "none", "--bind-addr", "0.0.0.0:8080", "."]
    # entrypoint: ["/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:8080", "."] # Uncomment this line to enable authentication
    environment:
      - BITSWAN_DEPLOY_URL=http://gitops:8079
      - BITSWAN_DEPLOY_SECRET=secret
    volumes:
      - bitswan-editor-data:/home/coder
```