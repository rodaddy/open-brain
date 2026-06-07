const table = "projects";
console.log(`SELECT
            a.id AS id_a,
            LEFT(a.name, 200) AS preview_a,
            b.id AS id_b,
            LEFT(b.name, 200) AS preview_b,
            a.embedding <=> b.embedding AS distance
          FROM ${table} a
          JOIN ${table} b ON a.id < b.id
            AND b.archived_at IS NULL
            AND b.embedding IS NOT NULL
          WHERE a.archived_at IS NULL
            AND a.embedding IS NOT NULL
            AND a.parent_id IS NULL AND b.parent_id IS NULL
            AND a.embedding <=> b.embedding < 0.08
          ORDER BY distance ASC
          LIMIT 20`);
