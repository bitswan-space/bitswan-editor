# Bitswan Editor
## Deployment
```yaml
  bitswan-editor:
    image: bitswan/bitswan-editor:<version>
    restart: always
    ports:
      - "9999:9999"
    entrypoint: ["/usr/bin/entrypoint.sh", "--auth", "none", "--bind-addr", "0.0.0.0:9999", "."]
    # entrypoint: ["/usr/bin/entrypoint.sh", "--bind-addr", "0.0.0.0:9999", "."] # Uncomment this line to enable authentication
    environment:
      - BITSWAN_DEPLOY_URL=http://gitops:8079
      - BITSWAN_DEPLOY_SECRET=secret
    volumes:
      - bitswan-editor-data:/home/coder
```