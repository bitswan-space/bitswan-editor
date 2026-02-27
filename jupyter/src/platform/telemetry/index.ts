// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
//
// BitSwan: All telemetry stripped — functions are no-ops or stubs.

import type { Disposable } from 'vscode';
import { noop, ExcludeType, PickType, UnionToIntersection } from '../common/utils/misc';
import { TelemetryEventInfo, IEventNamePropertyMapping } from '../../telemetry';

export { JupyterCommands, Telemetry } from '../common/constants';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function isTelemetryDisabled(): boolean {
    return true;
}

export function onDidChangeTelemetryEnablement(_handler: (enabled: boolean) => void): Disposable {
    return { dispose: noop };
}

export function setSharedProperty<P extends SharedPropertyMapping, E extends keyof P>(_name: E, _value?: P[E]): void {}

export function _resetSharedProperties(): void {}

export function getTelemetryReporter(): any {
    return {
        sendTelemetryEvent: noop,
        sendTelemetryErrorEvent: noop,
        sendDangerousTelemetryEvent: noop,
        dispose: noop,
    };
}

export function sendTelemetryEvent<P extends IEventNamePropertyMapping, E extends keyof P>(
    _eventName: E,
    _measures?: any,
    _properties?: any,
    _ex?: Error
) {}

export type TelemetryProperties<
    E extends keyof P,
    P extends IEventNamePropertyMapping = IEventNamePropertyMapping
> = P[E] extends TelemetryEventInfo<infer R>
    ? ExcludeType<R, number> extends never | undefined
        ? undefined
        : ExcludeType<R, number>
    : undefined | undefined;

export type TelemetryMeasures<
    E extends keyof P,
    P extends IEventNamePropertyMapping = IEventNamePropertyMapping
> = P[E] extends TelemetryEventInfo<infer R> ? PickType<UnionToIntersection<R>, number> : undefined;

// Type-parameterized form of MethodDecorator in lib.es5.d.ts.
type TypedMethodDescriptor<T> = (
    target: Object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>
) => TypedPropertyDescriptor<T> | void;

export type PickTypeNumberProps<T, Value> = {
    [P in keyof T as T[P] extends Value ? P : never]: T[P];
};
export type PickPropertiesOnly<T> = {
    [P in keyof T as T[P] extends TelemetryEventInfo<infer R>
        ? keyof PickType<R, number> extends never
            ? never
            : P
        : never]: T[P];
};

/**
 * Pass-through decorator — returns original descriptor unchanged.
 */
export function capturePerfTelemetry<This, P extends IEventNamePropertyMapping, E extends keyof PickPropertiesOnly<P>>(
    _eventName: E,
    _properties?: any
): TypedMethodDescriptor<(this: This, ...args: any[]) => any> {
    return function (
        _target: Object,
        _propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<(this: This, ...args: any[]) => any>
    ) {
        return descriptor;
    };
}

/**
 * Pass-through decorator — returns original descriptor unchanged.
 */
export function captureUsageTelemetry<This, P extends IEventNamePropertyMapping, E extends keyof P>(
    _eventName: E,
    _properties?: any
): TypedMethodDescriptor<(this: This, ...args: any[]) => any> {
    return function (
        _target: Object,
        _propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<(this: This, ...args: any[]) => any>
    ) {
        return descriptor;
    };
}

/**
 * Map all shared properties to their data types.
 */
export class SharedPropertyMapping {
    ['isInsiderExtension']: 'true' | 'false';
    ['rawKernelSupported']: 'true' | 'false';
    ['isPythonExtensionInstalled']: 'true' | 'false';
}
