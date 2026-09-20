/** 数据库资产域路由：中心 PostgreSQL 只读目录、表详情与整表 CSV 导出（表级白名单在 store 内收敛）。 */
import { type Request, type Response, type Router } from 'express';
import {
  clientErrorCode,
  queryInteger,
  queryText,
  requireObservabilityAccess,
} from './observability-route-kit.js';
import {
  createPostgresTableCsvExport,
  getPostgresDashboard,
  getPostgresTableDetail,
  PostgresTableDetailError,
  serializePostgresTableCsvLine,
} from './postgres-dashboard-store.js';
export function registerDatabaseRoutes(router: Router): void {
  /**
   * Central PostgreSQL read-only surfaces.  These routes intentionally call
   * the dashboard store rather than accepting SQL from the browser: the store
   * validates catalog identifiers, masks credential columns, and executes all
   * reads inside a bounded read-only transaction.
   */
  router.get(
    '/api/ops/observability/database',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      try {
        const hours = queryInteger(req.query as Record<string, unknown>, 'hours', 24, 1, 24 * 30);
        const database = await getPostgresDashboard(hours);
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, database });
      } catch (error) {
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'postgres_dashboard_query_failed'),
        });
      }
    },
  );

  router.get(
    '/api/ops/observability/database/tables/:tableName',
    requireObservabilityAccess,
    async (req: Request, res: Response) => {
      let exportStarted = false;
      try {
        const query = req.query as Record<string, unknown>;
        const format = String(query.format ?? 'json')
          .trim()
          .toLowerCase();
        if (format !== 'json' && format !== 'csv') {
          res.status(400).json({ ok: false, error: 'postgres_table_export_format_invalid' });
          return;
        }
        // Keep NUL bytes intact for the dashboard store's explicit catalog
        // validation (silently stripping them here would turn malformed input
        // into a different, potentially surprising identifier).
        const schemaName =
          String(query.schema ?? 'public')
            .trim()
            .slice(0, 128) || 'public';
        const tableName = String(req.params.tableName ?? '')
          .trim()
          .slice(0, 128);
        const sortColumn = queryText(query, 'sort', 128);
        const sortDirection = queryText(query, 'direction', 8)?.toLowerCase() as
          | 'asc'
          | 'desc'
          | undefined;

        if (format === 'csv') {
          exportStarted = true;
          const tableExport = await createPostgresTableCsvExport({
            schemaName,
            tableName,
            sortColumn,
            sortDirection,
          });
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${tableExport.filename}"`);
          res.flushHeaders();
          res.write(`\uFEFF${serializePostgresTableCsvLine(tableExport.columns)}\r\n`);
          for await (const row of tableExport.rows) {
            if (res.destroyed) break;
            const ready = res.write(
              `${serializePostgresTableCsvLine(tableExport.columns.map((column) => row[column]))}\r\n`,
            );
            if (!ready) {
              await new Promise<void>((resolve) => {
                const resume = () => {
                  res.off('drain', resume);
                  res.off('close', resume);
                  resolve();
                };
                res.once('drain', resume);
                res.once('close', resume);
              });
            }
          }
          if (!res.destroyed) res.end();
          return;
        }

        const detail = await getPostgresTableDetail({
          schemaName,
          tableName,
          page: queryInteger(query, 'page', 1, 1, 2_000),
          pageSize: queryInteger(query, 'pageSize', 25, 1, 50),
          sortColumn,
          sortDirection,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ok: true, detail });
      } catch (error) {
        if (res.headersSent) {
          if (exportStarted) res.destroy(error instanceof Error ? error : undefined);
          return;
        }
        if (error instanceof PostgresTableDetailError) {
          res.status(error.status).json({ ok: false, error: error.code });
          return;
        }
        res.status(503).json({
          ok: false,
          error: clientErrorCode(error, 'postgres_table_detail_query_failed'),
        });
      }
    },
  );
}
