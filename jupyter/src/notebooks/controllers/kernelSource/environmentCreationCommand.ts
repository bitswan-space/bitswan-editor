// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { CancellationTokenSource, commands, window } from 'vscode';
import type { IExtensionSyncActivationService } from '../../../platform/activation/types';
import { DisposableStore } from '../../../platform/common/utils/lifecycle';
import { injectable } from 'inversify';
import { JVSC_EXTENSION_ID } from '../../../platform/common/constants';
import { PythonEnvKernelConnectionCreator } from '../pythonEnvKernelConnectionCreator.node';

@injectable()
export class EnvironmentCreationCommand implements IExtensionSyncActivationService {
    activate(): void {
        // Disabled — only Bitswan remote kernels are used.
        return;
    }
}
