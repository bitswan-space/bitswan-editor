// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: Telemetry stripped — no-op.

import { Resource } from '../../platform/common/types';
import { IEventNamePropertyMapping } from '../../telemetry';

export function sendKernelTelemetryEvent<P extends IEventNamePropertyMapping, E extends keyof P>(
    _resource: Resource,
    _eventName: E,
    _measures?: any,
    _properties?: any,
    _ex?: Error | undefined
) {}
