/**
 * 接入自检：生成一个 OTLP gauge 指标报文，走与真实接入方完全相同的
 * ingestMetricPayload 管线落库——用户点一下按钮就能验证"代码接上去数据能被采集"。
 */

export const SELFTEST_METRIC = 'rdk.obs.selftest';

export function buildSelfTestMetricPayload(nowMs: number): {
  resourceMetrics: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
    scopeMetrics: Array<{ scope: { name: string }; metrics: Array<Record<string, unknown>> }>;
  }>;
} {
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'd-obs-selftest' } },
          ],
        },
        scopeMetrics: [
          {
            scope: { name: 'd-obs.selftest' },
            metrics: [
              {
                name: SELFTEST_METRIC,
                gauge: {
                  dataPoints: [
                    {
                      asDouble: Math.round((nowMs % 100_000) / 100) / 10,
                      timeUnixNano: String(nowMs * 1_000_000),
                      attributes: [{ key: 'source', value: { stringValue: 'selftest' } }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
