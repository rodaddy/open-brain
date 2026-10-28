/**
 * Anything the application starts and must stop before the database closes.
 *
 * Deliberately one method wide. The application orders shutdown; it does not
 * want to know whether the thing behind this is a queue runner, a NATS bridge,
 * or a sweeper.
 *
 * It lives in the domain tier rather than the application tier because the
 * maintenance tier implements it (`MaintenanceRuntime extends
 * BackgroundRuntime`) and a lower tier must not reach up for a type. Domain
 * sits below both, so both reach down (issue 1210).
 */
export interface BackgroundRuntime {
  readonly name: string;
  stop(): Promise<void>;
}
