// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import { NotebookDocument, commands, workspace } from 'vscode';
import { IExtensionSyncActivationService } from '../../platform/activation/types';
import { logger } from '../../platform/logging';
import { IDisposableRegistry } from '../../platform/common/types';
import { JVSC_EXTENSION_ID } from '../../platform/common/constants';
import { IControllerRegistration } from './types';
import { isJupyterNotebook } from '../../platform/common/utils';
import { isRemoteConnection } from '../../kernels/types';
import * as path from 'path';

const BITSWAN_EXTENSION_ID = 'LibertyAcesLtd.bitswan';

/**
 * Automatically connects BitSwan kernels to notebooks based on the automation
 * directory name matching the server handle.
 */
@injectable()
export class BitswanKernelAutoConnector implements IExtensionSyncActivationService {
    constructor(
        @inject(IDisposableRegistry) private readonly disposables: IDisposableRegistry,
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration
    ) {}

    public activate() {
        this.controllerRegistration.onDidChange(
            (e) => {
                if (e.added.length) {
                    this.onControllersAdded(e.added);
                }
            },
            this,
            this.disposables
        );

        workspace.onDidOpenNotebookDocument(this.onDidOpenNotebook, this, this.disposables);

        // Check already-open notebooks
        workspace.notebookDocuments.forEach((d) => this.onDidOpenNotebook(d));
    }

    private onControllersAdded(added: { id: string; connection: any }[]) {
        for (const controller of added) {
            const connection = controller.connection;
            if (!isRemoteConnection(connection)) {
                continue;
            }
            const handle = connection.serverProviderHandle;
            if (handle.extensionId !== BITSWAN_EXTENSION_ID) {
                continue;
            }

            // The handle is the automation name — match it to open notebooks
            const automationName = handle.handle;
            logger.info(`[BitswanAutoConnect] New BitSwan controller added: ${controller.id} for automation "${automationName}"`);

            for (const notebook of workspace.notebookDocuments) {
                if (!isJupyterNotebook(notebook)) {
                    continue;
                }
                const notebookDirName = path.basename(path.dirname(notebook.uri.fsPath));
                if (notebookDirName === automationName) {
                    this.selectController(notebook, controller.id);
                }
            }
        }
    }

    private onDidOpenNotebook(notebook: NotebookDocument) {
        if (!isJupyterNotebook(notebook)) {
            return;
        }

        // Don't override if a controller is already selected
        const selected = this.controllerRegistration.getSelected(notebook);
        if (selected) {
            return;
        }

        const notebookDirName = path.basename(path.dirname(notebook.uri.fsPath));

        // Check if a matching BitSwan controller already exists
        for (const controller of this.controllerRegistration.registered) {
            const connection = controller.connection;
            if (!isRemoteConnection(connection)) {
                continue;
            }
            const handle = connection.serverProviderHandle;
            if (handle.extensionId !== BITSWAN_EXTENSION_ID) {
                continue;
            }
            if (handle.handle === notebookDirName) {
                this.selectController(notebook, controller.id);
                return;
            }
        }
    }

    private selectController(notebook: NotebookDocument, controllerId: string) {
        logger.info(
            `[BitswanAutoConnect] Auto-selecting controller ${controllerId} for notebook ${path.basename(notebook.uri.fsPath)}`
        );
        commands
            .executeCommand('notebook.selectKernel', {
                id: controllerId,
                extension: JVSC_EXTENSION_ID
            })
            .then(undefined, (err) =>
                logger.error(`[BitswanAutoConnect] Failed to select kernel: ${err}`)
            );
    }
}
