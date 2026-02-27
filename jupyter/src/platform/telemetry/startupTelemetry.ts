// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: Telemetry stripped — all functions are no-ops.

export const startupDurations: {
    workspaceFolderCount: number;
    totalActivateTime: number;
    codeLoadingTime: number;
    startActivateTime: number;
    endActivateTime: number;
} = { codeLoadingTime: 0, endActivateTime: 0, startActivateTime: 0, totalActivateTime: 0, workspaceFolderCount: 0 };

export function sendStartupTelemetry(
    _durations: {
        workspaceFolderCount: number;
        totalActivateTime: number;
        codeLoadingTime: number;
        startActivateTime: number;
        endActivateTime: number;
    },
    _stopWatch: {
        elapsedTime: number;
    }
) {}

export function sendErrorTelemetry(
    _ex: Error,
    _durations: {
        workspaceFolderCount: number;
        totalActivateTime: number;
        endActivateTime: number;
        codeLoadingTime: number;
    },
    _stopWatch: {
        elapsedTime: number;
    }
) {}
