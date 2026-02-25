#!/usr/bin/env python3
"""
Generate a realistic sample .hmem SQLite database for SIGRID (senior backend/DevOps engineer).
Creates Althing_CEO/Agents/SAMPLE/SAMPLE.hmem with 60+ root entries across all prefixes.
"""

import sqlite3
import json
from datetime import datetime, timedelta
from pathlib import Path
import random

# Configuration
DB_PATH = Path("Althing_CEO/Agents/SAMPLE/SAMPLE.hmem")
START_DATE = datetime(2024, 3, 1)
END_DATE = datetime(2026, 2, 15)

def generate_date(start, end):
    """Generate random date between start and end."""
    delta = end - start
    random_days = random.randint(0, delta.days)
    random_seconds = random.randint(0, 86400)
    return (start + timedelta(days=random_days, seconds=random_seconds)).isoformat() + "Z"

def create_database():
    """Create the SQLite database with schema."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()

    # Create tables
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id            TEXT PRIMARY KEY,
            prefix        TEXT NOT NULL,
            seq           INTEGER NOT NULL,
            created_at    TEXT NOT NULL,
            level_1       TEXT NOT NULL,
            level_2       TEXT,
            level_3       TEXT,
            level_4       TEXT,
            level_5       TEXT,
            access_count  INTEGER DEFAULT 0,
            last_accessed TEXT,
            links         TEXT,
            min_role      TEXT DEFAULT 'worker'
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS memory_nodes (
            id            TEXT PRIMARY KEY,
            parent_id     TEXT NOT NULL,
            root_id       TEXT NOT NULL,
            depth         INTEGER NOT NULL,
            seq           INTEGER NOT NULL,
            content       TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            access_count  INTEGER DEFAULT 0,
            last_accessed TEXT
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS schema_version (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)

    cursor.execute("INSERT INTO schema_version VALUES ('tree_v1', 'done')")
    conn.commit()
    return conn

def generate_memories(conn):
    """Generate 60+ realistic memory entries for SIGRID persona."""
    cursor = conn.cursor()

    # SIGRID's background: Senior Backend/DevOps, 2+ years SaaS, K8s, PostgreSQL, Redis, etc.

    projects = [
        ("P0001", "SaaS Multi-Tenant API Platform",
         "Designed and deployed microservices architecture supporting 100+ customers. Built with Node.js, PostgreSQL, Redis.",
         ["P0010", "P0015"]),  # linked
        ("P0002", "Kubernetes Migration — Data Services",
         "Migrated 8 legacy VMs to EKS cluster. Reduced ops overhead by 60%, improved scaling.",
         ["P0008", "P0014"]),
        ("P0003", "PostgreSQL Sharding Project",
         "Implemented horizontal sharding for 500GB+ datasets. Query performance +80%.",
         ["P0006", "L0012"]),
        ("P0004", "Redis Caching Layer Redesign",
         "Rebuilt cache topology (consistent hashing). Cache hit ratio: 92% → 97%.",
         ["P0003", "P0009"]),
        ("P0005", "Performance Incident Response — Q3 2025",
         "Led root cause analysis of 5x query latency spike in production. Fixed N+1 queries.",
         ["L0008", "E0003"]),
        ("P0006", "Data Pipeline Refactor — ETL v2",
         "Rewrote streaming pipeline with Apache Kafka. Reduced data lag from 15min to 2sec.",
         ["P0003", "M0005"]),
        ("P0007", "GitHub Actions CI/CD Overhaul",
         "Built matrix testing across 12 Node versions. Reduced build time: 18min → 4min.",
         ["M0003", "L0005"]),
        ("P0008", "Team Onboarding Platform",
         "Created internal wiki + automated dev environment setup. Onboarding time: 3d → 4h.",
         ["P0002", "L0010"]),
        ("P0009", "Disaster Recovery & Backup",
         "Implemented multi-region backup strategy. RPO: 5min, RTO: 15min.",
         ["P0004", "D0004"]),
        ("P0010", "API Rate Limiting & DDoS Mitigation",
         "Built token-bucket algorithm + CloudFlare rules. Protected against 3 major DDoS events.",
         ["P0001", "E0005"]),
        ("P0011", "Terraform Infrastructure-as-Code",
         "Converted manual AWS setup to IaC. 200+ resources, drift detection enabled.",
         ["M0002", "D0003"]),
        ("P0012", "Database Replication & Failover",
         "Set up streaming replication with automated failover. Achieved 99.9% SLA.",
         ["P0003", "P0009"]),
        ("P0013", "Load Testing & Capacity Planning",
         "k6 + InfluxDB monitoring. Identified bottleneck: connection pooling. Fixed in v2.4.",
         ["L0011", "E0002"]),
        ("P0014", "Logging & Observability Stack",
         "Deployed ELK stack + custom dashboards. Reduced MTTR by 45%.",
         ["P0002", "D0005"]),
        ("P0015", "Cost Optimization Initiative",
         "Reduced AWS spend 35% via reserved instances + spot fleet. Saved $400k/year.",
         ["P0001", "D0001"]),
    ]

    lessons = [
        ("L0001", "Always measure baseline before optimization claims",
         "Claimed 50% speedup without metric proof. Audit forced proper benchmarking.",
         ["E0001", "P0013"]),
        ("L0002", "Schema evolution requires backward compatibility",
         "New JSON column broke old code for 2 hours. Now run canary first.",
         ["E0007", "P0003"]),
        ("L0003", "Document Terraform state carefully — it's your source of truth",
         "Lost RDS snapshot list due to manual deletion. Now: state backups + versioning.",
         ["P0011", "D0003"]),
        ("L0004", "Kubernetes nodepool drain must account for pod disruption budgets",
         "Drained too fast, lost requests mid-flight. PDB policy: min 2 replicas running.",
         ["P0002", "E0004"]),
        ("L0005", "CI/CD flakiness kills developer velocity more than slow builds",
         "3min faster but 15% failure rate (network race). Slowed to 4min, 0.2% failure.",
         ["P0007", "D0002"]),
        ("L0006", "Production incidents rarely have single root cause",
         "Thought it was cache miss. Actually: cache + DB connection leak + slow query.",
         ["P0005", "E0003"]),
        ("L0007", "Use feature flags even for 'simple' rollouts",
         "Rolled feature without flag. Had to revert via emergency deploy. Now mandatory.",
         ["E0006", "D0006"]),
        ("L0008", "Monitor your monitors (meta-alerting)",
         "Alert system itself crashed silently. Missed outage for 30 min.",
         ["P0005", "E0008"]),
        ("L0009", "Data migrations must be reversible",
         "One-way migration script. Broke production, had to restore from backup.",
         ["E0009", "P0006"]),
        ("L0010", "Invest in developer ergonomics early",
         "10 minute onboarding setup saved 200+ hours over 2 years vs manual docs.",
         ["P0008", "M0004"]),
        ("L0011", "Load testing must use realistic data distributions",
         "Test with uniform data. Production had Zipfian distribution. Cache missed.",
         ["P0013", "E0002"]),
        ("L0012", "Index usage changes with data growth patterns",
         "Index optimal at 10GB. At 300GB, query planner switched strategy.",
         ["P0003", "P0006"]),
        ("L0013", "Cross-team dependencies must be explicit",
         "Assumed frontend would handle retry. They didn't. Built request queue instead.",
         ["D0002", "E0007"]),
        ("L0014", "Ops debt compounds faster than code debt",
         "One manual process → 3 months later → critical path item stealing 20% time.",
         ["M0001", "D0005"]),
        ("L0015", "Reserve 10% capacity headroom at all times",
         "Running at 90% CPU. Single spike → cascading failures. Now hard limit: 70%.",
         ["P0015", "D0004"]),
    ]

    errors = [
        ("E0001", "Premature optimization without measurement",
         "Rewrote sorting in Rust. Turned out main bottleneck was I/O, not CPU.",
         ["L0001"]),
        ("E0002", "Cache invalidation distributed system bug",
         "Stale read in 1/100 replicas. Inconsistent state for 5 minutes.",
         ["P0013", "L0011"]),
        ("E0003", "N+1 database queries in ORM layer",
         "Loop fetching user → 100 queries. Bulk load fixed. Latency: 5s → 50ms.",
         ["P0005", "L0006"]),
        ("E0004", "Kubernetes node termination race condition",
         "Pod not drained before shutdown. Lost in-flight requests.",
         ["P0002", "L0004"]),
        ("E0005", "DDoS rate limiting bypass via header injection",
         "Attacker spoofed X-Forwarded-For. Deployed Lua script for verification.",
         ["P0010"]),
        ("E0006", "Deployed breaking change to stable API",
         "Removed optional field. Mobile app hardcoded it. Batch rollback required.",
         ["L0007", "D0006"]),
        ("E0007", "Schema migration lock timeout",
         "ALTER TABLE waited for running query. Blocked all writes for 20 minutes.",
         ["P0003", "L0002"]),
        ("E0008", "Alerting system used same database as app",
         "DB issues masked by broken monitoring. Alert query also failed.",
         ["L0008", "P0014"]),
        ("E0009", "Data migration irreversibility",
         "Deleted old column. New code failed. Had to restore. Lost 2 hours.",
         ["L0009", "P0006"]),
        ("E0010", "Environment variable typo in production",
         "DB_PASS vs DB_PASSWORD. Silent failure, took 30 min to debug.",
         ["M0002", "D0005"]),
    ]

    decisions = [
        ("D0001", "Chose spot instances over reserved for batch workloads",
         "Lower cost (60%), acceptable 5min interruption SLA. Saves $50k/month.",
         ["P0015"]),
        ("D0002", "Implemented feature flags across all services",
         "Upfront cost: 20h. Payoff: safe rollouts, instant rollback. Now standard.",
         ["L0005", "L0013"]),
        ("D0003", "Migrated from CloudFormation to Terraform",
         "Better state tracking, cleaner syntax. Learning curve: 2 weeks, worth it.",
         ["P0011", "L0003"]),
        ("D0004", "Switched from master-slave to multi-master replication",
         "Better HA, but more conflict resolution complexity. Trade accepted.",
         ["P0009", "L0015"]),
        ("D0005", "Centralized logging to ELK instead of grep",
         "Initial setup: 40h. Saved 200h in debugging within first year.",
         ["P0014", "E0010"]),
        ("D0006", "Mandatory code review before production merge",
         "Added 1-2h latency per deployment. Reduced production issues by 40%.",
         ["L0007"]),
        ("D0007", "Redis for session state, PostgreSQL for authoritative data",
         "Hybrid approach. Session loss acceptable, data loss is not.",
         ["P0004"]),
        ("D0008", "Kubernetes for stateless services only (not databases)",
         "K8s not ready for stateful DB management in 2024. Use RDS instead.",
         ["P0002", "M0001"]),
    ]

    milestones = [
        ("M0001", "Automated infrastructure fully operational — 2024-09-15",
         "All 200+ resources now IaC + CI/CD. Manual AWS console access no longer needed.",
         ["P0011", "L0014"]),
        ("M0002", "Zero-downtime deployment capability achieved",
         "Blue-green + canary patterns. Largest incident: 2 min, invisible to users.",
         ["P0007", "D0008"]),
        ("M0003", "Build pipeline <5 minutes across all services",
         "Matrix testing optimized. Developers happy. Velocity increased.",
         ["P0007"]),
        ("M0004", "Onboarding time <4 hours from Git access to first PR",
         "Automated environment setup. Previously: 3 days manual docs.",
         ["P0008", "L0010"]),
        ("M0005", "End-to-end data freshness <2 seconds",
         "Migrated to Kafka streaming. Real-time dashboards now possible.",
         ["P0006", "L0012"]),
        ("M0006", "99.95% SLA for 18 consecutive months",
         "Multi-region failover tested. Team confidence: high.",
         ["P0009", "P0014"]),
    ]

    skills = [
        ("S0001", "PostgreSQL query optimization & explain plans",
         "Can analyze 50+ slow queries per week. Expertise in indexing strategies.",
         []),
        ("S0002", "Kubernetes cluster operations at scale",
         "Deployed 3 EKS clusters. Familiar with StatefulSets, DaemonSets, custom schedulers.",
         ["P0002"]),
        ("S0003", "Terraform module design & state management",
         "Built 15+ reusable modules. Proficient in state locking, drift detection.",
         ["P0011"]),
        ("S0004", "Incident response & root cause analysis (RCA)",
         "Led 20+ post-mortems. Strong at timeline reconstruction, blameless culture.",
         ["P0005", "L0006"]),
    ]

    favorites = [
        ("F0001", "Blog: 'Why You Should Not Use Kubernetes for Databases' by ArgoCD team",
         "Challenged my assumptions. Learned about stateful workload complexity.",
         []),
        ("F0002", "Tool: k6 load testing framework",
         "Simple, powerful, JavaScript-based. Changed how we think about capacity planning.",
         ["P0013"]),
    ]

    all_entries = projects + lessons + errors + decisions + milestones + skills + favorites

    seq_counter = {prefix: 0 for prefix in "PLEMDMSF"}
    node_seq = 0

    # All IDs we'll create (for linking)
    all_ids = [entry[0] for entry in all_entries]

    for entry_id, name, level_1, linked_ids in all_entries:
        prefix = entry_id[0]  # Extract prefix from ID (P, L, E, D, M, S, or F)
        seq_counter[prefix] += 1

        created_at = generate_date(START_DATE, END_DATE)
        access_count = random.randint(1, 50) if random.random() > 0.3 else random.randint(1, 5)
        last_accessed = generate_date(START_DATE, END_DATE)

        # Filter valid links
        valid_links = [lid for lid in linked_ids if lid in all_ids]
        links_json = json.dumps(valid_links) if valid_links else None

        # Determine min_role
        min_role = random.choice(['worker', 'worker', 'worker', 'al']) if random.random() > 0.8 else 'worker'

        cursor.execute("""
            INSERT INTO memories
            (id, prefix, seq, created_at, level_1, level_2, level_3, level_4, level_5,
             access_count, last_accessed, links, min_role)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
        """, (entry_id, prefix, seq_counter[prefix], created_at, level_1,
              access_count, last_accessed, links_json, min_role))

        # Generate memory_nodes for hierarchical structure
        # About 42% of entries have L2 children (25+ roots with L2)
        num_l2_nodes = random.randint(1, 3) if random.random() > 0.58 else 0

        for l2_idx in range(num_l2_nodes):
            node_seq += 1
            l2_node_id = f"{entry_id}.{l2_idx + 1}"
            l2_content = f"Detail point {l2_idx + 1} for {entry_id}"

            cursor.execute("""
                INSERT INTO memory_nodes
                (id, parent_id, root_id, depth, seq, content, created_at, access_count, last_accessed)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (l2_node_id, entry_id, entry_id, 2, node_seq, l2_content, created_at,
                  random.randint(1, 30), last_accessed))

            # About 40% of L2 nodes have L3 children (10+ roots with L3)
            if random.random() > 0.60:
                l3_node_id = f"{entry_id}.{l2_idx + 1}.1"
                l3_content = f"Deeper detail for {l2_node_id}"
                node_seq += 1

                cursor.execute("""
                    INSERT INTO memory_nodes
                    (id, parent_id, root_id, depth, seq, content, created_at, access_count, last_accessed)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (l3_node_id, l2_node_id, entry_id, 3, node_seq, l3_content, created_at,
                      random.randint(1, 20), last_accessed))

                # Rare L4 nodes (3+ roots with L4)
                if random.random() > 0.85:
                    l4_node_id = f"{entry_id}.{l2_idx + 1}.1.1"
                    l4_content = f"Technical detail for {l3_node_id}"
                    node_seq += 1

                    cursor.execute("""
                        INSERT INTO memory_nodes
                        (id, parent_id, root_id, depth, seq, content, created_at, access_count, last_accessed)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """, (l4_node_id, l3_node_id, entry_id, 4, node_seq, l4_content, created_at,
                          random.randint(1, 10), last_accessed))

    conn.commit()
    return len(all_entries)

def main():
    """Generate the database."""
    print("Creating Althing_CEO/Agents/SAMPLE/SAMPLE.hmem...")

    conn = create_database()
    num_entries = generate_memories(conn)
    conn.close()

    print(f"✓ Generated {num_entries} root entries")

    # Verify
    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()

    memories_count = cursor.execute("SELECT COUNT(*) FROM memories").fetchone()[0]
    nodes_count = cursor.execute("SELECT COUNT(*) FROM memory_nodes").fetchone()[0]

    # Count entries by prefix
    prefix_counts = cursor.execute(
        "SELECT prefix, COUNT(*) FROM memories GROUP BY prefix ORDER BY prefix"
    ).fetchall()

    # Count roots with L2+ nodes
    roots_with_l2 = cursor.execute(
        "SELECT COUNT(DISTINCT root_id) FROM memory_nodes WHERE depth >= 2"
    ).fetchone()[0]

    roots_with_l3 = cursor.execute(
        "SELECT COUNT(DISTINCT root_id) FROM memory_nodes WHERE depth >= 3"
    ).fetchone()[0]

    roots_with_l4 = cursor.execute(
        "SELECT COUNT(DISTINCT root_id) FROM memory_nodes WHERE depth >= 4"
    ).fetchone()[0]

    conn.close()

    print(f"✓ memories table: {memories_count} entries")
    print(f"✓ memory_nodes table: {nodes_count} hierarchical nodes")
    print(f"\nBreakdown by prefix:")
    for prefix, count in prefix_counts:
        print(f"  {prefix}: {count}")
    print(f"\nHierarchy depth:")
    print(f"  Roots with L2+ nodes: {roots_with_l2}")
    print(f"  Roots with L3+ nodes: {roots_with_l3}")
    print(f"  Roots with L4+ nodes: {roots_with_l4}")

    print(f"\n✓ Database created: {DB_PATH}")

if __name__ == "__main__":
    main()
