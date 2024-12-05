import vscode from 'vscode';
import path from 'path';
import JSZip from 'jszip';
import { Readable } from 'stream';
import axios from 'axios';
import FormData from 'form-data';

export const zipDirectory = async (dirPath: string, relativePath: string = '', zipFile: JSZip = new JSZip()) => {

  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
  for (const [name, type] of entries) {
    const fullPath = path.join(dirPath, name);
    const zipPath = path.join(relativePath, name);

    if (type === vscode.FileType.Directory) {
      await zipDirectory(fullPath, zipPath, zipFile);
    } else {
      const content = await vscode.workspace.fs.readFile(vscode.Uri.file(fullPath));
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


export const zipBsLib = async (workspacePath: string) => {

  const bitswanLibPath = path.join(workspacePath, 'bitswan_lib');

  const zipFile = await zipDirectory(bitswanLibPath);

  return zipFile;
}


export const deploy = async (deployUrl: string, form: FormData) => {
  const response = await axios.post(deployUrl, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });

  return response.status == 200;
}

export const activateDeployment = async (deployUrl: string) => {
  const response = await axios.get(deployUrl);

  return response.status == 200;
}
