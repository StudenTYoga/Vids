import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  useEdgesState,
  useNodesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import ontologyData from '../../k12_math_ontology.json';
import './MathOntologyBoard.css';

// ─── Colour palette per domain ────────────────────────────────
const PALETTE = {
  pre_math:                    '#7c3aed',
  numbers:                     '#2563eb',
  arithmetic:                  '#16a34a',
  algebra:                     '#ea580c',
  geometry:                    '#0891b2',
  trigonometry:                '#dc2626',
  statistics_probability:      '#db2777',
  precalculus_calculus_bridge: '#d97706',
  university_math:             '#4f46e5',
};

// ─── Viewport persistence ─────────────────────────────────────
const VIEWPORT_KEY   = 'math-ontology-viewport';
const UNDERSTOOD_KEY = 'math-ontology-understood';

function loadViewport() {
  try {
    const raw = localStorage.getItem(VIEWPORT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveViewport({ x, y, zoom }) {
  try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x, y, zoom })); } catch {}
}

function loadUnderstood() {
  try {
    const raw = localStorage.getItem(UNDERSTOOD_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}
function saveUnderstood(set) {
  try { localStorage.setItem(UNDERSTOOD_KEY, JSON.stringify([...set])); } catch {}
}

// ─── Prerequisite chain traversal (BFS upward) ───────────────
function getPrereqChain(startId, prereqMap) {
  const result = new Set();
  const queue  = [...(prereqMap[startId] ?? [])];
  while (queue.length) {
    const id = queue.shift();
    if (result.has(id)) continue;
    result.add(id);
    (prereqMap[id] ?? []).forEach((pid) => queue.push(pid));
  }
  return result; // ancestors only, startId excluded
}

// ─── Context menu ─────────────────────────────────────────────
function ContextMenu({ menu, isUnderstood, onHighlight, onToggleUnderstood, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onKey   = (e) => { if (e.key === 'Escape') onClose(); };
    // Delay adding click-outside listener so it doesn't fire on the
    // same right-click that opened the menu
    const t = setTimeout(() => {
      const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
      window.addEventListener('click', onClick);
      ref.current._cleanup = () => window.removeEventListener('click', onClick);
    }, 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
      ref.current?._cleanup?.();
    };
  }, [menu, onClose]);

  if (!menu) return null;

  // Clamp so menu stays inside the viewport
  const W   = window.innerWidth;
  const H   = window.innerHeight;
  const MXW = 220;
  const MXH = 90;
  const left = Math.min(menu.x, W - MXW - 8);
  const top  = Math.min(menu.y, H - MXH - 8);

  return (
    <div ref={ref} className="ctx-menu" style={{ top, left }}>
      <button className="ctx-menu__item" onClick={onHighlight}>
        <span className="ctx-menu__icon">🔗</span>
        Highlight prerequisites
      </button>
      <button
        className={`ctx-menu__item ${isUnderstood ? 'ctx-menu__item--active' : ''}`}
        onClick={onToggleUnderstood}
      >
        <span className="ctx-menu__icon">{isUnderstood ? '✅' : '⬜'}</span>
        {isUnderstood ? 'Unmark as understood' : 'Mark as understood'}
      </button>
    </div>
  );
}

// ─── Custom node components ───────────────────────────────────

function MetaNode({ data }) {
  return (
    <div className="meta-node">
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
      <div className="meta-node__star">✦</div>
      <div className="meta-node__name">{data.label}</div>
      {data.description && <p className="meta-node__desc">{data.description}</p>}
    </div>
  );
}

function DomainNode({ data }) {
  return (
    <div className="domain-node" style={{ background: data.color }}>
      <div className="domain-node__label">{data.label}</div>
    </div>
  );
}

function ConceptNode({ data }) {
  return (
    <div
      className={[
        'concept-node',
        data.isHighlighted ? 'concept-node--hl'         : '',
        data.isUnderstood  ? 'concept-node--understood' : '',
      ].filter(Boolean).join(' ')}
      style={{ '--color': data.color }}
    >
      <Handle type="target" position={Position.Left}   style={{ opacity: 0 }} />
      <Handle type="target" position={Position.Top}    style={{ opacity: 0 }} id="t-top" />

      <div className="concept-node__name">
        {data.label}
        {data.isUnderstood && <span className="concept-node__badge">✓</span>}
      </div>

      {data.formula && (
        <div className="concept-node__formula">{data.formula}</div>
      )}
      {data.apps?.length > 0 && (
        <div className="concept-node__tags">
          {data.apps.slice(0, 2).map((a) => (
            <span key={a} className="concept-node__tag">{a}</span>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Right}  style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} id="s-bottom" />
    </div>
  );
}

const NODE_TYPES = {
  meta:    MetaNode,
  domain:  DomainNode,
  concept: ConceptNode,
};

// ─── Layout constants ─────────────────────────────────────────
const COL_WIDTH       = 260;
const CONCEPT_START_Y = 190;
const CONCEPT_GAP     = 130;
const META_Y          = -330;

// ─── Graph builder ────────────────────────────────────────────
function buildGraph(data, showRelated, understoodSet, highlightedSet) {
  const uSet = understoodSet  ?? new Set();
  const hSet = highlightedSet ?? new Set();

  const nodes = [];
  const edges = [];
  const pos   = {};

  // Domain columns + concept nodes
  data.domains.forEach((domain, di) => {
    const x     = di * COL_WIDTH;
    const color = PALETTE[domain.id] ?? '#64748b';

    nodes.push({
      id:         `domain::${domain.id}`,
      type:       'domain',
      position:   { x: x - 6, y: 0 },
      draggable:  false,
      selectable: false,
      data:       { label: domain.name, color },
    });

    domain.concepts.forEach((c, ci) => {
      const y = CONCEPT_START_Y + ci * CONCEPT_GAP;
      pos[c.id] = { x, y };
      nodes.push({
        id:       c.id,
        type:     'concept',
        position: { x, y },
        data: {
          label:         c.name,
          formula:       c.formula,
          apps:          c.applications,
          color,
          isUnderstood:  uSet.has(c.id),
          isHighlighted: hSet.has(c.id),
        },
      });
    });
  });

  // Meta concept nodes — spread across the top
  const totalW = (data.domains.length - 1) * COL_WIDTH;
  data.meta_concepts.forEach((m, i) => {
    nodes.push({
      id:       `meta::${m.id}`,
      type:     'meta',
      position: {
        x: (i / (data.meta_concepts.length - 1)) * totalW - 90,
        y: META_Y,
      },
      data: { label: m.name, description: m.description },
    });
  });

  // Edges
  const known      = new Set(Object.keys(pos));
  const relEdgeIds = new Set();

  data.domains.forEach((domain) => {
    domain.concepts.forEach((c) => {
      (c.prerequisites ?? []).forEach((pid) => {
        if (!known.has(pid) || pid === c.id) return;
        edges.push({
          id:        `pre::${pid}::${c.id}`,
          source:    pid,
          target:    c.id,
          type:      'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed, color: '#64748b', width: 14, height: 14 },
          style:     { stroke: '#64748b', strokeWidth: 1.5 },
        });
      });

      if (showRelated) {
        (c.related_to ?? []).forEach((rid) => {
          if (!known.has(rid) || rid === c.id) return;
          const key = [c.id, rid].sort().join('::');
          if (relEdgeIds.has(key)) return;
          relEdgeIds.add(key);
          edges.push({
            id:     `rel::${key}`,
            source: c.id,
            target: rid,
            type:   'straight',
            style:  { stroke: '#475569', strokeWidth: 1, strokeDasharray: '6 4' },
          });
        });
      }
    });
  });

  return { nodes, edges };
}

// ─── Main component ───────────────────────────────────────────
export default function MathOntologyBoard() {
  const [showRelated, setShowRelated] = useState(false);
  const [menu,        setMenu]        = useState(null);           // { nodeId, x, y } | null
  const [highlighted, setHighlighted] = useState(() => new Set());
  const [understood,  setUnderstood]  = useState(loadUnderstood); // Set<string>

  const savedViewport = useMemo(() => loadViewport(), []);

  // prereqMap: conceptId → string[] of prerequisite IDs
  const prereqMap = useMemo(() => {
    const map = {};
    ontologyData.domains.forEach((d) =>
      d.concepts.forEach((c) => { map[c.id] = c.prerequisites ?? []; })
    );
    return map;
  }, []);

  // Initial nodes — bake in understood from localStorage so there's no flash
  const init = useMemo(
    () => buildGraph(ontologyData, false, loadUnderstood(), new Set()),
    [], // intentionally run once
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(init.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(init.edges);

  // Patch isHighlighted / isUnderstood into existing nodes without full rebuild
  const applyMeta = useCallback((hlSet, undSet) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.type !== 'concept'
          ? n
          : { ...n, data: { ...n.data, isHighlighted: hlSet.has(n.id), isUnderstood: undSet.has(n.id) } }
      )
    );
  }, [setNodes]);

  // ── Toolbar toggle ──
  const handleToggle = useCallback((e) => {
    const checked = e.target.checked;
    setShowRelated(checked);
    const { nodes: n, edges: eg } = buildGraph(ontologyData, checked, understood, highlighted);
    setNodes(n);
    setEdges(eg);
  }, [setNodes, setEdges, understood, highlighted]);

  // ── Viewport save ──
  const handleMoveEnd = useCallback((_, viewport) => saveViewport(viewport), []);

  // ── Context menu ──
  const onNodeContextMenu = useCallback((e, node) => {
    e.preventDefault();
    if (node.type !== 'concept') return;
    setMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Clicking the empty canvas clears the menu AND the highlight
  const onPaneClick = useCallback(() => {
    setMenu(null);
    setHighlighted(new Set());
    applyMeta(new Set(), understood);
  }, [applyMeta, understood]);

  const handleHighlightPrereqs = useCallback(() => {
    if (!menu) return;
    const chain = getPrereqChain(menu.nodeId, prereqMap);
    chain.add(menu.nodeId); // include the selected node itself
    setHighlighted(chain);
    applyMeta(chain, understood);
    setMenu(null);
  }, [menu, prereqMap, understood, applyMeta]);

  const handleToggleUnderstood = useCallback(() => {
    if (!menu) return;
    const next = new Set(understood);
    if (next.has(menu.nodeId)) next.delete(menu.nodeId);
    else                        next.add(menu.nodeId);
    setUnderstood(next);
    saveUnderstood(next);
    applyMeta(highlighted, next);
    setMenu(null);
  }, [menu, understood, highlighted, applyMeta]);

  return (
    <div className="board-root">
      {/* ── Context menu (rendered outside ReactFlow to avoid z-index issues) ── */}
      <ContextMenu
        menu={menu}
        isUnderstood={menu ? understood.has(menu.nodeId) : false}
        onHighlight={handleHighlightPrereqs}
        onToggleUnderstood={handleToggleUnderstood}
        onClose={closeMenu}
      />

      {/* ── Toolbar ── */}
      <header className="toolbar">
        <span className="toolbar__title">K12 Math Ontology</span>

        <label className="toolbar__toggle">
          <input type="checkbox" checked={showRelated} onChange={handleToggle} />
          Show related connections
        </label>

        <div className="toolbar__legend">
          {ontologyData.domains.map((d) => (
            <span key={d.id} className="legend-item" style={{ '--c': PALETTE[d.id] ?? '#64748b' }}>
              {d.name}
            </span>
          ))}
        </div>
      </header>

      {/* ── Canvas ── */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES}
        nodesConnectable={false}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        {...(savedViewport
          ? { defaultViewport: savedViewport }
          : { fitView: true, fitViewOptions: { padding: 0.1 } }
        )}
        onMoveEnd={handleMoveEnd}
        minZoom={0.05}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="#1e293b" />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            if (n.type === 'meta')   return '#f59e0b';
            if (n.type === 'domain') return n.data.color;
            return n.data?.color ?? '#64748b';
          }}
          maskColor="rgba(15,23,42,0.75)"
          style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 8 }}
        />
      </ReactFlow>
    </div>
  );
}
