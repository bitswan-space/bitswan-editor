import vscode from 'vscode';
import path from 'path';
import JSZip from 'jszip';
import { Readable } from 'stream';
import axios from 'axios';
import FormData from 'form-data';

export const zipDirectory = async (dirPath: string, relativePath: string = '', zipFile: JSZip = new JSZip(), outputChannel: vscode.OutputChannel) => {

  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
  for (const [name, type] of entries) {
    const fullPath = path.join(dirPath, name);
    const zipPath = path.join(relativePath, name);

    if (type === vscode.FileType.Directory) {
      await zipDirectory(fullPath, zipPath, zipFile, outputChannel);
    } else {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
      outputChannel.appendLine(`Adding file ${fullPath}`);
      zipFile.file(zipPath, content);
    }
  }

  return zipFile;
};


export const zip2stream = async (zipFile: JSZip) => {
  const stream = new Readable();

  stream.push(await zipFile.generateAsync({ type: 'nodebuffer' }));
  stream.push(null);

  return stream;

}


export const deploy = async (deployUrl: string, form: FormData, secret: string) => {
  const response = await axios.post(deployUrl, form, {
    headers: { 
      'Content-Type': 'multipart/form-data',
      'Authorization': `Bearer ${secret}`
    },
  });

  return response.status == 200;
}

export const activateDeployment = async (deployUrl: string, secret: string) => {
  const response = await axios.post(
    deployUrl,
    {},
    {
      headers: {
        'Authorization': `Bearer ${secret}`,
      },
    }
  );

  return response.status == 200;
}
