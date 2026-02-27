// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: Telemetry stripped — all functions are no-ops.

import { Resource } from '../common/types';
import { IFileSystem } from '../common/platform/types';

export function sendFileCreationTelemetry() {}

export async function sendActivationTelemetry(_fileSystem: IFileSystem, _resource: Resource) {}

export namespace EnvFileTelemetryTests {
    export function setState(_opts: { telemetrySent?: boolean; defaultSetting?: string }) {}
    export function resetState() {}
}
