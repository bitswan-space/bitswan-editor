// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inject, injectable } from 'inversify';
import {
    CancellationTokenSource,
    commands,
    EventEmitter,
    NotebookControllerAffinity,
    NotebookDocument,
    NotebookKernelSourceAction,
    notebooks,
    Uri,
    window
} from 'vscode';
import { DisplayOptions } from '../../../kernels/displayOptions';
import { isPythonKernelConnection, isUserRegisteredKernelSpecConnection } from '../../../kernels/helpers';
import { ContributedKernelFinderKind } from '../../../kernels/internalTypes';
import { IJupyterServerProviderRegistry } from '../../../kernels/jupyter/types';
import { initializeInteractiveOrNotebookTelemetryBasedOnUserAction } from '../../../kernels/telemetry/helper';
import { sendKernelTelemetryEvent } from '../../../kernels/telemetry/sendKernelTelemetryEvent';
import {
    IKernelDependencyService,
    IKernelFinder,
    isLocalConnection,
    KernelConnectionMetadata
} from '../../../kernels/types';
import { IExtensionSyncActivationService } from '../../../platform/activation/types';
import {
    InteractiveWindowView,
    JupyterNotebookView,
    Telemetry,
    TestingKernelPickerProviderId,
    isWebExtension
} from '../../../platform/common/constants';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { IDisposable, IDisposableRegistry } from '../../../platform/common/types';
import { DataScience } from '../../../platform/common/utils/localize';
import { noop } from '../../../platform/common/utils/misc';
import { ServiceContainer } from '../../../platform/ioc/container';
import { logger } from '../../../platform/logging';
import { INotebookEditorProvider } from '../../types';
import {
    IControllerRegistration,
    ILocalNotebookKernelSourceSelector,
    ILocalPythonNotebookKernelSourceSelector,
    IRemoteNotebookKernelSourceSelector,
    IVSCodeNotebookController
} from '../types';
import { JupyterServerCollection } from '../../../api';
import { isCondaEnvironmentWithoutPython } from '../../../platform/interpreter/helpers';
import { onDidManuallySelectKernel } from '../../../kernels/telemetry/notebookTelemetry';

@injectable()
export class KernelSourceCommandHandler implements IExtensionSyncActivationService {
    private localDisposables: IDisposable[] = [];
    private readonly providerMappings = new Map<
        string,
        { disposables: IDisposable[]; provider: JupyterServerCollection }
    >();
    private kernelSpecsSourceRegistered = false;
    constructor(
        @inject(IControllerRegistration) private readonly controllerRegistration: IControllerRegistration,
        @inject(IKernelFinder) private readonly kernelFinder: IKernelFinder,
        @inject(INotebookEditorProvider) private readonly notebookEditorProvider: INotebookEditorProvider,
        @inject(IKernelDependencyService) private readonly kernelDependency: IKernelDependencyService,
        @inject(IDisposableRegistry) disposables: IDisposableRegistry
    ) {
        disposables.push(this);
    }
    public dispose() {
        dispose(this.localDisposables);
    }
    activate(): void {
        // Kernel selection is managed by the Bitswan extension.
        return;
    }
    private registerUriCommands() {
        const uriRegistration =
            ServiceContainer.instance.get<IJupyterServerProviderRegistry>(IJupyterServerProviderRegistry);
        const existingItems = new Set<string>();
        uriRegistration.jupyterCollections.map((collection) => {
            const id = `${collection.extensionId}:${collection.id}`;
            if (collection.id === TestingKernelPickerProviderId) {
                return;
            }
            existingItems.add(id);
            if (this.providerMappings.has(id)) {
                return;
            }
            const providerItemNb = notebooks.registerKernelSourceActionProvider(JupyterNotebookView, {
                provideNotebookKernelSourceActions: () => {
                    return [
                        {
                            get label() {
                                return collection.label;
                            },
                            get documentation() {
                                return collection.documentation;
                            },
                            command: {
                                command: 'jupyter.kernel.selectJupyterServerKernel',
                                arguments: [collection.extensionId, collection.id],
                                title: collection.label
                            }
                        }
                    ];
                }
            });
            const providerItemIW = notebooks.registerKernelSourceActionProvider(InteractiveWindowView, {
                provideNotebookKernelSourceActions: () => {
                    return [
                        {
                            get label() {
                                return collection.label;
                            },
                            get documentation() {
                                return collection.documentation;
                            },
                            command: {
                                command: 'jupyter.kernel.selectJupyterServerKernel',
                                arguments: [collection.extensionId, collection.id],
                                title: collection.label
                            }
                        }
                    ];
                }
            });
            this.localDisposables.push(providerItemNb);
            this.localDisposables.push(providerItemIW);
            this.providerMappings.set(id, { disposables: [providerItemNb, providerItemIW], provider: collection });
        });
        this.providerMappings.forEach(({ disposables }, id) => {
            if (!existingItems.has(id)) {
                dispose(disposables);
                this.providerMappings.delete(id);
            }
        });
    }
    private async onSelectLocalKernel(
        kind: ContributedKernelFinderKind.LocalKernelSpec | ContributedKernelFinderKind.LocalPythonEnvironment,
        notebook?: NotebookDocument
    ) {
        notebook = notebook || window.activeNotebookEditor?.notebook;
        if (!notebook) {
            return;
        }
        if (kind === ContributedKernelFinderKind.LocalPythonEnvironment) {
            const selector = ServiceContainer.instance.get<ILocalPythonNotebookKernelSourceSelector>(
                ILocalPythonNotebookKernelSourceSelector
            );
            const kernel = await selector.selectLocalKernel(notebook);
            return this.getSelectedController(notebook, kernel);
        } else {
            const selector = ServiceContainer.instance.get<ILocalNotebookKernelSourceSelector>(
                ILocalNotebookKernelSourceSelector
            );
            const kernel = await selector.selectLocalKernel(notebook);
            return this.getSelectedController(notebook, kernel);
        }
    }
    private async onSelectRemoteKernel(extensionId: string, providerId: string, notebook?: NotebookDocument) {
        notebook = notebook || window.activeNotebookEditor?.notebook;
        if (!notebook && window.activeTextEditor) {
            // find associated notebook document for the active text editor
            notebook = this.notebookEditorProvider.findNotebookEditor(window.activeTextEditor.document.uri)?.notebook;
        }
        if (!notebook) {
            return;
        }
        const id = `${extensionId}:${providerId}`;
        const provider = this.providerMappings.get(id)?.provider;
        if (!provider) {
            return;
        }
        const selector = ServiceContainer.instance.get<IRemoteNotebookKernelSourceSelector>(
            IRemoteNotebookKernelSourceSelector
        );
        const kernel = await selector.selectRemoteKernel(notebook, provider);
        return this.getSelectedController(notebook, kernel);
    }
    private async getSelectedController(notebook: NotebookDocument, kernel?: KernelConnectionMetadata) {
        if (!kernel) {
            return;
        }
        const controllers = this.controllerRegistration.addOrUpdate(kernel, [
            notebook.notebookType as typeof JupyterNotebookView | typeof InteractiveWindowView
        ]);
        if (!Array.isArray(controllers) || controllers.length === 0) {
            logger.warn(`No controller created for selected kernel connection ${kernel.kind}:${kernel.id}`);
            return;
        }
        initializeInteractiveOrNotebookTelemetryBasedOnUserAction(notebook.uri, kernel)
            .finally(() =>
                sendKernelTelemetryEvent(notebook.uri, Telemetry.SwitchKernel, undefined, { newKernelPicker: true })
            )
            .catch(noop);
        controllers
            .find((item) => item.viewType === notebook.notebookType)
            ?.controller.updateNotebookAffinity(notebook, NotebookControllerAffinity.Preferred);

        const controller = controllers[0];
        await this.onControllerSelected(notebook, controller);
        return controller.controller.id;
    }
    private async onControllerSelected(notebook: NotebookDocument, controller: IVSCodeNotebookController) {
        onDidManuallySelectKernel(notebook);
        if (
            isLocalConnection(controller.connection) &&
            isPythonKernelConnection(controller.connection) &&
            isCondaEnvironmentWithoutPython(controller.connection.interpreter) &&
            !isWebExtension()
        ) {
            const disposables: IDisposable[] = [];
            try {
                const token = new CancellationTokenSource();
                disposables.push(token);
                const ui = new DisplayOptions(false);
                disposables.push(ui);
                await this.kernelDependency.installMissingDependencies({
                    resource: notebook.uri,
                    kernelConnection: controller.connection,
                    token: token.token,
                    ui,
                    cannotChangeKernels: true,
                    ignoreCache: true,
                    installWithoutPrompting: true
                });
            } catch (ex) {
                logger.error(`Failed to install missing dependencies for Conda kernel ${controller.connection.id}`, ex);
            } finally {
                dispose(disposables);
            }
        }
    }
}
