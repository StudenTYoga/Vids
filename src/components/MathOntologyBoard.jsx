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
import ontologyData  from '../../k12_math_ontology.json';
import coursesIndex  from '../../courses/index.json';

const courseFiles = import.meta.glob('../../courses/*.json', { eager: true });
const _allCourses = Object.fromEntries(
  Object.values(courseFiles)
    .map((m) => m.default)
    .filter((c) => c?.video_id)
    .map((c) => [c.video_id, c])
);
const courseById = Object.fromEntries(
  coursesIndex.videos.map(({ video_id }) => [video_id, _allCourses[video_id]]).filter(([, v]) => v)
);
import './MathOntologyBoard.css';

function fmtDuration(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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

// ─── Prerequisite traversal (one level only) ──────────────────
function getPrereqChain(startId, prereqMap) {
  return new Set(prereqMap[startId] ?? []);
}

// ─── Context menu ─────────────────────────────────────────────
function ContextMenu({ menu, isUnderstood, onHighlight, onHighlightRelated, onShowCourses, onToggleUnderstood, onAskAI, onClose }) {
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
  const MXH = 170;
  const left = Math.min(menu.x, W - MXW - 8);
  const top  = Math.min(menu.y, H - MXH - 8);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="ctx-menu__item" onClick={onHighlight}>
        <span className="ctx-menu__icon">🔗</span>
        Highlight prerequisites
      </button>
      <button className="ctx-menu__item" onClick={onHighlightRelated}>
        <span className="ctx-menu__icon">↔️</span>
        Highlight related to
      </button>
      <button className="ctx-menu__item" onClick={onShowCourses}>
        <span className="ctx-menu__icon">🎬</span>
        Show related courses
      </button>
      <button
        className={`ctx-menu__item ${isUnderstood ? 'ctx-menu__item--active' : ''}`}
        onClick={onToggleUnderstood}
      >
        <span className="ctx-menu__icon">{isUnderstood ? '✅' : '⬜'}</span>
        {isUnderstood ? 'Unmark as understood' : 'Mark as understood'}
      </button>
      <button className="ctx-menu__item" onClick={onAskAI}>
        <span className="ctx-menu__icon">🤖</span>
        Ask AI
      </button>
    </div>
  );
}

// ─── Course card context menu ─────────────────────────────────
function CourseContextMenu({ menu, onHighlight, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
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
  const left = Math.min(menu.x, window.innerWidth  - 220 - 8);
  const top  = Math.min(menu.y, window.innerHeight -  60 - 8);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button className="ctx-menu__item" onClick={() => onHighlight(menu.video)}>
        <span className="ctx-menu__icon">✨</span>
        Highlight concepts
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
        data.isHighlighted && data.hlMode === 'prereq'   ? 'concept-node--hl'          : '',
        data.isHighlighted && data.hlMode === 'related'  ? 'concept-node--hl-related'  : '',
        data.isHighlighted && data.hlMode === 'course'   ? 'concept-node--hl-course'   : '',
        data.isUnderstood                                ? 'concept-node--understood'  : '',
        data.isBorder                                    ? 'concept-node--border'      : '',
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

// ─── Course card ──────────────────────────────────────────────
function CourseCard({ video, conceptId, onContextMenu }) {
  const entry = video.concept_path.find((cp) => cp.concept_id === conceptId);
  const tSec  = entry?.time_sec ?? null;
  const ytUrl = `https://www.youtube.com/watch?v=${video.video_id}${tSec ? `&t=${tSec}` : ''}`;

  const handleContextMenu = (e) => {
    e.preventDefault();
    onContextMenu?.(e, video);
  };

  return (
    <a
      href={ytUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="course-card"
      onContextMenu={handleContextMenu}
    >
      <div className="course-card__top">
        <span className="course-card__lang">{video.language}</span>
        {video.verified && <span className="course-card__verified">✓ verified</span>}
      </div>
      <div className="course-card__title">{video.title}</div>
      <div className="course-card__meta">
        <span className="course-card__channel">{video.channel}</span>
        <span className="course-card__duration">{fmtDuration(video.duration_sec)}</span>
      </div>
      {tSec != null && (
        <div className="course-card__timestamp">
          📍 此概念出現於 <strong>{fmtDuration(tSec)}</strong>
        </div>
      )}
    </a>
  );
}

// ─── Side panel ───────────────────────────────────────────────
function SidePanel({ open, onToggle, selectedConcept, onCourseContextMenu }) {
  const courses = useMemo(() => {
    if (!selectedConcept) return [];
    const ids = coursesIndex.concept_coverage[selectedConcept.id] ?? [];
    return ids.map((vid) => courseById[vid]).filter(Boolean);
  }, [selectedConcept]);

  return (
    <aside className={`side-panel ${open ? 'side-panel--open' : ''}`}>
      <button
        className="side-panel__toggle"
        onClick={onToggle}
        aria-label={open ? 'Collapse panel' : 'Expand panel'}
      >
        {open ? '›' : '‹'}
      </button>

      <div className="side-panel__inner">
        <header className="side-panel__head">
          <span className="side-panel__title">
            {selectedConcept ? selectedConcept.label : 'Course Player'}
          </span>
        </header>

        <div className="side-panel__body">
          {!selectedConcept ? (
            <div className="side-panel__placeholder">
              <div className="side-panel__ph-icon">🎬</div>
              <p className="side-panel__ph-text">
                Right-click a concept node and choose<br />
                <em>Show related courses</em>.
              </p>
            </div>
          ) : courses.length === 0 ? (
            <div className="side-panel__placeholder">
              <div className="side-panel__ph-icon">🔍</div>
              <p className="side-panel__ph-text">
                No courses indexed for<br />
                <strong>{selectedConcept.label}</strong> yet.
              </p>
            </div>
          ) : (
            <div className="course-list">
              <p className="course-list__hint">
                {courses.length} course{courses.length > 1 ? 's' : ''} covering{' '}
                <strong>{selectedConcept.label}</strong>
              </p>
              {courses.map((video) => (
                <CourseCard
                  key={video.video_id}
                  video={video}
                  conceptId={selectedConcept.id}
                  onContextMenu={onCourseContextMenu}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Layout constants ─────────────────────────────────────────
const COL_WIDTH       = 260;
const CONCEPT_START_Y = 190;
const CONCEPT_GAP     = 130;
const META_Y          = -330;

// ─── Graph builder ────────────────────────────────────────────
function buildGraph(data, showRelated, understoodSet, highlightedSet, hlMode = null) {
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
          hlMode:        hSet.has(c.id) ? hlMode : null,
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
          type:      'straight',
          markerEnd: { type: MarkerType.ArrowClosed, color: 'rgba(148,163,184,0.6)', width: 10, height: 10 },
          style:     { stroke: 'rgba(148,163,184,0.35)', strokeWidth: 1 },
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
  const [showRelated,          setShowRelated]          = useState(false);
  const [showKnowledgeBorder,  setShowKnowledgeBorder]  = useState(false);
  const [panelOpen,       setPanelOpen]       = useState(false);
  const [selectedConcept, setSelectedConcept] = useState(null); // { id, label }
  const [menu,            setMenu]            = useState(null);  // node context menu
  const [courseMenu,      setCourseMenu]      = useState(null);  // { video, x, y }            // { nodeId, x, y } | null
  const [highlighted,   setHighlighted]   = useState(() => new Set());
  const [hlMode,        setHlMode]        = useState(null);            // 'prereq' | 'related' | null
  const [understood,    setUnderstood]    = useState(loadUnderstood);  // Set<string>

  const savedViewport = useMemo(() => loadViewport(), []);

  // conceptLabelMap: id → display name (for context menu handler)
  const conceptLabelMap = useMemo(() => {
    const map = {};
    ontologyData.domains.forEach((d) => d.concepts.forEach((c) => { map[c.id] = c.name; }));
    return map;
  }, []);

  // prereqMap: conceptId → prerequisite IDs
  const prereqMap = useMemo(() => {
    const map = {};
    ontologyData.domains.forEach((d) =>
      d.concepts.forEach((c) => { map[c.id] = c.prerequisites ?? []; })
    );
    return map;
  }, []);

  // relatedMap: conceptId → related_to IDs that actually exist as concept nodes
  const relatedMap = useMemo(() => {
    const known = new Set(ontologyData.domains.flatMap((d) => d.concepts.map((c) => c.id)));
    const map   = {};
    ontologyData.domains.forEach((d) =>
      d.concepts.forEach((c) => {
        map[c.id] = (c.related_to ?? []).filter((id) => known.has(id));
      })
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

  // Patch isHighlighted / isUnderstood / hlMode into existing nodes without full rebuild
  const applyMeta = useCallback((hlSet, undSet, mode = null) => {
    setNodes((nds) =>
      nds.map((n) =>
        n.type !== 'concept' ? n : {
          ...n,
          data: {
            ...n.data,
            isHighlighted: hlSet.has(n.id),
            hlMode:        hlSet.has(n.id) ? mode : null,
            isUnderstood:  undSet.has(n.id),
          },
        }
      )
    );
  }, [setNodes]);

  // ── Knowledge border: patch isBorder whenever toggle or understood changes ──
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) =>
        n.type !== 'concept' ? n : {
          ...n,
          data: {
            ...n.data,
            isBorder: showKnowledgeBorder &&
              !understood.has(n.id) &&
              (prereqMap[n.id] ?? []).every((p) => understood.has(p)),
          },
        }
      )
    );
  }, [showKnowledgeBorder, understood, prereqMap, setNodes]);

  // ── Toolbar toggle ──
  const handleToggle = useCallback((e) => {
    const checked = e.target.checked;
    setShowRelated(checked);
    const { nodes: n, edges: eg } = buildGraph(ontologyData, checked, understood, highlighted, hlMode);
    setNodes(n);
    setEdges(eg);
  }, [setNodes, setEdges, understood, highlighted, hlMode]);

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
    setHlMode(null);
    applyMeta(new Set(), understood, null);
  }, [applyMeta, understood]);

  const handleHighlightPrereqs = useCallback(() => {
    if (!menu) return;
    const chain = getPrereqChain(menu.nodeId, prereqMap);
    chain.add(menu.nodeId);
    setHighlighted(chain);
    setHlMode('prereq');
    applyMeta(chain, understood, 'prereq');
    setMenu(null);
  }, [menu, prereqMap, understood, applyMeta]);

  const handleHighlightRelated = useCallback(() => {
    if (!menu) return;
    const related = new Set(relatedMap[menu.nodeId] ?? []);
    related.add(menu.nodeId);
    setHighlighted(related);
    setHlMode('related');
    applyMeta(related, understood, 'related');
    setMenu(null);
  }, [menu, relatedMap, understood, applyMeta]);

  const handleCourseContextMenu = useCallback((e, video) => {
    e.preventDefault();
    setCourseMenu({ video, x: e.clientX, y: e.clientY });
  }, []);

  const closeCourseMenu = useCallback(() => setCourseMenu(null), []);

  const handleHighlightCourseConcepts = useCallback((video) => {
    if (!video) return;
    const ids = new Set(video.concept_path.map((cp) => cp.concept_id));
    setHighlighted(ids);
    setHlMode('course');
    applyMeta(ids, understood, 'course');
    setCourseMenu(null);
  }, [understood, applyMeta]);

  const handleShowCourses = useCallback(() => {
    if (!menu) return;
    setSelectedConcept({ id: menu.nodeId, label: conceptLabelMap[menu.nodeId] ?? menu.nodeId });
    setPanelOpen(true);
    setMenu(null);
  }, [menu, conceptLabelMap]);

  const handleToggleUnderstood = useCallback(() => {
    if (!menu) return;
    const next = new Set(understood);
    if (next.has(menu.nodeId)) next.delete(menu.nodeId);
    else                        next.add(menu.nodeId);
    setUnderstood(next);
    saveUnderstood(next);
    applyMeta(highlighted, next, hlMode);
    setMenu(null);
  }, [menu, understood, highlighted, hlMode, applyMeta]);

  const handleAskAI = useCallback(() => {
    if (!menu) return;
    const understoodNames = [...understood].map((id) => conceptLabelMap[id]).filter(Boolean);
    const targetName = conceptLabelMap[menu.nodeId] ?? menu.nodeId;
    const understoodPart = understoodNames.length > 0 ? understoodNames.join(', ') : 'none';
    const prompt = `With understood concepts: ${understoodPart} — how should I learn ${targetName}?`;
    navigator.clipboard.writeText(prompt);
    setMenu(null);
  }, [menu, understood, conceptLabelMap]);

  return (
    <div className="board-root">
      {/* ── Course card context menu ── */}
      <CourseContextMenu
        menu={courseMenu}
        onHighlight={handleHighlightCourseConcepts}
        onClose={closeCourseMenu}
      />

      {/* ── Node context menu ── */}
      <ContextMenu
        menu={menu}
        isUnderstood={menu ? understood.has(menu.nodeId) : false}
        onHighlight={handleHighlightPrereqs}
        onHighlightRelated={handleHighlightRelated}
        onShowCourses={handleShowCourses}
        onToggleUnderstood={handleToggleUnderstood}
        onAskAI={handleAskAI}
        onClose={closeMenu}
      />

      {/* ── Toolbar ── */}
      <header className="toolbar">
        <span className="toolbar__title">K12 Math Ontology</span>

        <label className="toolbar__toggle">
          <input type="checkbox" checked={showRelated} onChange={handleToggle} />
          Show related connections
        </label>

        <label className="toolbar__toggle">
          <input type="checkbox" checked={showKnowledgeBorder} onChange={(e) => setShowKnowledgeBorder(e.target.checked)} />
          Show knowledge border
        </label>

        <div className="toolbar__legend">
          {ontologyData.domains.map((d) => (
            <span key={d.id} className="legend-item" style={{ '--c': PALETTE[d.id] ?? '#64748b' }}>
              {d.name}
            </span>
          ))}
        </div>
      </header>

      {/* ── Canvas + side panel ── */}
      <div className="board-body">
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

        <SidePanel
          open={panelOpen}
          onToggle={() => setPanelOpen((v) => !v)}
          selectedConcept={selectedConcept}
          onCourseContextMenu={handleCourseContextMenu}
        />
      </div>
    </div>
  );
}
