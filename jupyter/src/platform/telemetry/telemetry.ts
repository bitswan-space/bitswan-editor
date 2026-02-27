// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: Telemetry stripped — all functions are no-ops or stubs.

import { Uri } from 'vscode';
import { Resource } from '../common/types';
import { ResourceSpecificTelemetryProperties } from '../../telemetry';
import { PythonEnvironment } from '../pythonEnvironments/info';

type Context = {
    previouslySelectedKernelConnectionId: string;
};
export const trackedInfo = new Map<string, [ResourceSpecificTelemetryProperties, Context]>();
export const pythonEnvironmentsByHash = new Map<string, PythonEnvironment>();
type InterpreterPackageProvider = (interpreter: PythonEnvironment) => Promise<Map<string, string>>;

export function initializeGlobals(_interpreterPackageProvider: InterpreterPackageProvider) {}

export function updatePythonPackages(
    _currentData: ResourceSpecificTelemetryProperties,
    _clonedCurrentData?: ResourceSpecificTelemetryProperties
) {}

export function deleteTrackedInformation(_resource: Uri) {}

export async function getContextualPropsForTelemetry(_resource: Resource): Promise<ResourceSpecificTelemetryProperties> {
    return {};
}
