// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: Telemetry stripped — tracker functions return stubs, activate is a no-op.

import { type NotebookDocument, type Uri } from 'vscode';
import { DisposableStore } from '../../platform/common/utils/lifecycle';
import type { Environment } from '@vscode/python-extension';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-use-before-define, @typescript-eslint/no-unused-vars */

export type NotebookFirstStartBreakDownMeasures = Record<string, number | undefined>;

const emptyTracker = () => undefined;
const noopOnce = () => ({ stop: () => {} });

const stubTracker = {
    kernelSelected: (_kernelConnectionId: string, _interpreterId?: string) => {},
    kernelManuallySelected: () => {},
    cellExecutionCount: emptyTracker,
    preExecuteCellTelemetry: emptyTracker,
    startKernel: emptyTracker,
    executeCell: emptyTracker,
    executeCellAcknowledged: emptyTracker,
    jupyterSessionTelemetry: emptyTracker,
    postKernelStartup: emptyTracker,
    computeCwd: emptyTracker,
    getConnection: emptyTracker,
    updateConnection: emptyTracker,
    kernelReady: emptyTracker,
    portUsage: emptyTracker,
    spawn: emptyTracker,
    pythonEnvVars: emptyTracker,
    envVars: emptyTracker,
    interruptHandle: emptyTracker,
    kernelInfo: emptyTracker,
    kernelIdle: emptyTracker,
};

export function getNotebookTelemetryTracker(_query: NotebookDocument | Uri | undefined) {
    return stubTracker;
}

export function activateNotebookTelemetry(_stopWatch: { elapsedTime: number }) {
    return new DisposableStore();
}

export function onDidManuallySelectKernel(_notebook: NotebookDocument) {}

export const trackPythonExtensionActivation = () => {
    return { stop: () => {} };
};

export function trackControllerCreation(_kernelConnectionId: string, _pythonInterpreterId?: string) {}

export function trackInterpreterDiscovery(_pythonEnv: Environment) {}
