/**
 * Compile-time drift check between the dashboard's copy of the contracts (./types) and
 * @davecode/core. Type-only: never imported by the app, checked by tsconfig.node.json.
 */
import type * as Core from '@davecode/core';
import type * as Ui from './types';

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ContractChecks = [
  Assert<Equals<Ui.ModelInfo, Core.ModelInfo>>,
  Assert<Equals<Ui.ProviderKind, Core.ProviderKind>>,
  Assert<Equals<Ui.QuotaLimits, Core.QuotaLimits>>,
  Assert<Equals<Ui.AccountStatus, Core.AccountStatus>>,
  Assert<Equals<Ui.Account, Core.Account>>,
  Assert<Equals<Ui.RouteTarget, Core.RouteTarget>>,
  Assert<Equals<Ui.Route, Core.Route>>,
  Assert<Equals<Ui.QuotaWindow, Core.QuotaWindow>>,
  Assert<Equals<Ui.WindowUsage, Core.WindowUsage>>,
  Assert<Equals<Ui.AccountUsage, Core.AccountUsage>>,
  Assert<Equals<Ui.UsageStatus, Core.UsageStatus>>,
  Assert<Equals<Ui.UsageRecord, Core.UsageRecord>>,
  Assert<Equals<Ui.TaskStatus, Core.TaskStatus>>,
  Assert<Equals<Ui.TaskNode, Core.TaskNode>>,
  Assert<Equals<Ui.TaskGraph, Core.TaskGraph>>,
  Assert<Equals<Ui.RunnerState, Core.RunnerState>>,
  Assert<Equals<Ui.RunnerStatus, Core.RunnerStatus>>,
  Assert<Equals<Ui.ProviderErrorKind, Core.ProviderErrorKind>>,
  Assert<Equals<Ui.LogLevel, Core.LogLevel>>,
  Assert<Equals<Ui.DaveEvent, Core.DaveEvent>>,
  Assert<Equals<Ui.DaveEventType, Core.DaveEventType>>,
];
