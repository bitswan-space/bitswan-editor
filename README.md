# Bitswan Editor
## Deployment
Use the [`bitswan cli`](https://github.com/bitswan-space/bitswan-workspaces) to deploy.

## Development

Open the `Extension` directory in vscode. Go to the Run menu and click "Start Debugging"

![image](https://github.com/user-attachments/assets/098bfd23-20fe-436d-a4ec-181cbb496c65)

To hook up a gitops instance for development purposes switch to the newly created window. Find the bitswan icon. Scroll down to "WORKSPACES" in the side bar, and click the plus icon:

![image](https://github.com/user-attachments/assets/c9eaf9e0-63bc-4a4e-82aa-a956e262484b)

In development, the URL for [bitswan-gitops](https://github.com/bitswan-space/bitswan-gitops) is `bitswan.localhost:8079`.

The secret can be found in the `.env` file you created when setting it up.
