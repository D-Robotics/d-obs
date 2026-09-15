const FAIL_CLOSED_ADAPTER = {
    getSessionSsoUser: () => null,
    // 未装配时不猜测本地单用户形态，按最严格的部署形态处理。
    isMultiUserWebDeployment: () => true,
    allowsAnonymousLocalOperator: () => false,
    resolveChatPrincipalAccountId: () => '',
};
let currentAdapter = null;
/** 组合根装配期调用；重复装配以最后一次为准。 */
export function configureObservabilityAccess(adapter) {
    currentAdapter = adapter;
}
/** 测试专用：恢复 fail-closed 默认。 */
export function resetObservabilityAccessAdapter() {
    currentAdapter = null;
}
export function getObservabilityAccessAdapter() {
    return currentAdapter ?? FAIL_CLOSED_ADAPTER;
}
export function getSessionSsoUser(req) {
    return getObservabilityAccessAdapter().getSessionSsoUser(req);
}
export function isMultiUserWebDeployment() {
    return getObservabilityAccessAdapter().isMultiUserWebDeployment();
}
export function deploymentAllowsAnonymousLocalOperator() {
    return getObservabilityAccessAdapter().allowsAnonymousLocalOperator();
}
export function resolveChatPrincipalAccountId(req) {
    return getObservabilityAccessAdapter().resolveChatPrincipalAccountId(req);
}
