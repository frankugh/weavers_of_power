import { useEffect, useMemo, useRef, useState } from "react";
import { requestJson } from "./api.js";

const NODE_TYPES = { SCENE: "scene", COMBAT: "combat" };
const NODE_LABELS = { scene: "Scene", combat: "Combat" };
const LEGACY_SCENE_TYPES = new Set(["start", "story", "event"]);
const NODE_W = 150;
const NODE_H = 66;

function normalizeNodeType(type) {
  const normalized = String(type || "").trim().toLowerCase();
  return normalized === "combat" ? "combat" : "scene";
}

function normalizePhase(raw, index) {
  const phase = raw && typeof raw === "object" ? { ...raw } : {};
  const id = String(phase.id || `phase_${index + 1}`).trim() || `phase_${index + 1}`;
  return {
    ...phase,
    id,
    label: String(phase.label || (index === 0 ? "Default" : id)),
    text: String(phase.text || ""),
    imageRef: phase.imageRef || null,
  };
}

function normalizeNode(raw, index) {
  const node = raw && typeof raw === "object" ? { ...raw } : {};
  const id = String(node.id || `node_${index + 1}`).trim() || `node_${index + 1}`;
  const type = normalizeNodeType(LEGACY_SCENE_TYPES.has(node.type) ? "scene" : node.type);
  const phases = (Array.isArray(node.phases) ? node.phases : []).map(normalizePhase);
  if (!phases.length) {
    phases.push(normalizePhase({ id: "phase_default", label: "Default", text: "" }, 0));
  }
  const phaseIds = new Set(phases.map((phase) => phase.id));
  const defaultPhaseId = phaseIds.has(node.defaultPhaseId) ? node.defaultPhaseId : phases[0].id;
  const combatRaw = node.combat && typeof node.combat === "object" ? node.combat : {};
  const enemies = Array.isArray(combatRaw.enemies)
    ? combatRaw.enemies
        .map((entry) => ({
          ...entry,
          templateId: String(entry?.templateId || "").trim(),
          count: Math.max(1, Math.min(20, Number.parseInt(entry?.count, 10) || 1)),
        }))
        .filter((entry) => entry.templateId)
    : [];
  return {
    ...node,
    id,
    type,
    label: String(node.label || NODE_LABELS[type]),
    position: {
      x: Number.isFinite(Number(node.position?.x)) ? Number(node.position.x) : 80 + index * 190,
      y: Number.isFinite(Number(node.position?.y)) ? Number(node.position.y) : 100,
    },
    phases,
    defaultPhaseId,
    combat: type === "combat" ? { ...combatRaw, enemies, mapRef: combatRaw.mapRef || null } : null,
  };
}

function normalizeDefinition(raw) {
  const definition = raw && typeof raw === "object" ? { ...raw } : {};
  const nodes = (Array.isArray(definition.nodes) ? definition.nodes : []).map(normalizeNode);
  if (!nodes.length) {
    nodes.push(normalizeNode({
      id: "start",
      type: "scene",
      label: "Start",
      position: { x: 100, y: 100 },
      phases: [{ id: "phase_default", label: "Default", text: "" }],
      defaultPhaseId: "phase_default",
    }, 0));
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const legacyStart = (Array.isArray(definition.nodes) ? definition.nodes : []).find(
    (node) => String(node?.type || "").trim().toLowerCase() === "start",
  )?.id;
  const startNodeId = nodeIds.has(definition.startNodeId)
    ? definition.startNodeId
    : nodeIds.has(legacyStart)
      ? legacyStart
      : nodes[0].id;
  const edges = (Array.isArray(definition.edges) ? definition.edges : [])
    .map((edge, index) => ({
      ...edge,
      id: String(edge?.id || `edge_${index + 1}`).trim() || `edge_${index + 1}`,
      from: String(edge?.from || ""),
      to: String(edge?.to || ""),
      label: String(edge?.label || ""),
      condition: edge?.condition && typeof edge.condition === "object" ? edge.condition : null,
    }))
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  return {
    ...definition,
    id: String(definition.id || `scenario_${Date.now().toString(36)}`),
    name: String(definition.name || "New Scenario"),
    startNodeId,
    nodes,
    edges,
  };
}

function cloneDefinition(definition) {
  return normalizeDefinition(JSON.parse(JSON.stringify(definition || {})));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function getScenarioRun(snapshot) {
  const run = snapshot?.scenario?.scenarioRun || snapshot?.scenarioRun;
  if (run) return run;
  const runtime = snapshot?.scenario?.runtime;
  if (!runtime?.scenarioId) {
    return { active: false, sourceScenarioId: null, sourceScenarioName: null, sourceTemplateMissing: false };
  }
  return {
    active: true,
    sourceScenarioId: runtime.sourceScenarioId || runtime.scenarioId,
    sourceScenarioName: runtime.sourceScenarioName || snapshot?.scenario?.definition?.name || runtime.scenarioId,
    sourceTemplateMissing: false,
    currentNodeId: runtime.currentNodeId,
  };
}

function getActivePhase(node, nodeState) {
  const phases = node?.phases || [];
  if (!phases.length) return null;
  const phaseId = nodeState?.phaseId || node?.defaultPhaseId || phases[0].id;
  return phases.find((phase) => phase.id === phaseId) || phases[0];
}

function nodeCenter(node) {
  return { x: (node.position?.x ?? 0) + NODE_W / 2, y: (node.position?.y ?? 0) + NODE_H / 2 };
}

function edgePoints(fromNode, toNode) {
  const a = nodeCenter(fromNode);
  const b = nodeCenter(toNode);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function templateCategory(template) {
  return template?.part || template?.category || "Uncategorized";
}

function templateSection(template) {
  return template?.section || "Uncategorized";
}

function templateThreat(template) {
  const value = Number.parseInt(template?.threatLevel, 10);
  return Number.isFinite(value) ? value : null;
}

function isSpawnable(template) {
  return template?.spawnable !== false;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function findTemplate(meta, templateId) {
  return (meta?.enemyTemplates || []).find((template) => template.id === templateId) || null;
}

function ArrowDefs() {
  return (
    <defs>
      <marker id="scenario-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="rgba(218, 188, 126, 0.72)" />
      </marker>
      <marker id="scenario-arrow-active" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
        <polygon points="0 0, 8 3, 0 6" fill="rgba(245, 216, 150, 0.95)" />
      </marker>
    </defs>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.75 3.5h4.5" />
      <path d="M4.5 4.75h7" />
      <path d="M6.25 2.5h3.5l.5 1h-4.5z" />
      <path d="M5.25 4.75v6.25c0 .69.56 1.25 1.25 1.25h3c.69 0 1.25-.56 1.25-1.25V4.75" />
      <path d="M6.75 6.5v4" />
      <path d="M9.25 6.5v4" />
    </svg>
  );
}

function ScenarioEdge({ edge, nodesById, active, editable, onDelete }) {
  const fromNode = nodesById[edge.from];
  const toNode = nodesById[edge.to];
  if (!fromNode || !toNode) return null;
  const { x1, y1, x2, y2 } = edgePoints(fromNode, toNode);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  return (
    <g className="scenario-edge">
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={active ? "rgba(245, 216, 150, 0.95)" : "rgba(218, 188, 126, 0.48)"}
        strokeWidth={active ? 2.2 : 1.5}
        markerEnd={active ? "url(#scenario-arrow-active)" : "url(#scenario-arrow)"}
      />
      {edge.label ? (
        <text
          x={midX}
          y={midY - 7}
          textAnchor="middle"
          fontSize="10"
          fill={active ? "rgba(255, 239, 194, 0.96)" : "rgba(238, 218, 175, 0.76)"}
          className="scenario-edge-label"
        >
          {edge.label}
        </text>
      ) : null}
      {editable ? (
        <g
          className="scenario-edge-delete"
          role="button"
          tabIndex="0"
          aria-label={`Delete edge ${edge.label || edge.id}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete(edge.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onDelete(edge.id);
            }
          }}
        >
          <circle cx={midX} cy={midY} r="9" />
          <text x={midX} y={midY + 3} textAnchor="middle">x</text>
        </g>
      ) : null}
    </g>
  );
}

function ScenarioNode({
  node,
  isCurrent,
  isVisited,
  isSelected,
  editable,
  isStart,
  onNavigate,
  onSelect,
  onMove,
}) {
  const dragStart = useRef(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const left = (node.position?.x ?? 0) + (dragging ? dragOffset.x : 0);
  const top = (node.position?.y ?? 0) + (dragging ? dragOffset.y : 0);

  function handleMouseDown(event) {
    if (!editable) return;
    event.stopPropagation();
    dragStart.current = { x: event.clientX, y: event.clientY };
    setDragging(true);
    setDragOffset({ x: 0, y: 0 });

    function onMouseMove(moveEvent) {
      const dx = moveEvent.clientX - dragStart.current.x;
      const dy = moveEvent.clientY - dragStart.current.y;
      setDragOffset({ x: dx, y: dy });
    }

    function onMouseUp(upEvent) {
      const dx = upEvent.clientX - dragStart.current.x;
      const dy = upEvent.clientY - dragStart.current.y;
      setDragging(false);
      setDragOffset({ x: 0, y: 0 });
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        onMove(node.id, dx, dy);
      } else {
        onSelect(node.id);
      }
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function handleClick(event) {
    event.stopPropagation();
    if (editable) {
      onSelect(node.id);
    } else {
      onNavigate(node.id);
    }
  }

  const className = [
    "scenario-node",
    `scenario-node-${node.type}`,
    isCurrent ? "scenario-node-current" : "",
    isVisited && !isCurrent ? "scenario-node-visited" : "",
    isSelected ? "scenario-node-selected" : "",
    isStart ? "scenario-node-start-marker" : "",
  ].filter(Boolean).join(" ");

  return (
    <button
      type="button"
      className={className}
      style={{ left, top, width: NODE_W, height: NODE_H }}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
    >
      <span className="scenario-node-top-strip" aria-hidden="true" />
      <span className="scenario-node-type-badge">{NODE_LABELS[node.type] || "Scene"}</span>
      <span className="scenario-node-label">{node.label || "Unnamed"}</span>
      {isStart ? <span className="scenario-start-badge">Start</span> : null}
    </button>
  );
}

function FlowOverview({
  definition,
  runtime,
  editable,
  selectedNodeId,
  onSelectNode,
  onNavigate,
  onMoveNode,
  onDeleteEdge,
}) {
  const viewportRef = useRef(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const panStart = useRef(null);
  const nodes = definition?.nodes || [];
  const edges = definition?.edges || [];
  const nodesById = useMemo(() => Object.fromEntries(nodes.map((node) => [node.id, node])), [nodes]);
  const currentNodeId = runtime?.currentNodeId;
  const visitedNodeIds = runtime?.visitedNodeIds || [];
  const canvasW = Math.max(820, ...nodes.map((node) => (node.position?.x ?? 0) + NODE_W + 80));
  const canvasH = Math.max(520, ...nodes.map((node) => (node.position?.y ?? 0) + NODE_H + 80));

  function handleMouseDown(event) {
    if (event.target !== viewportRef.current && !event.target.classList.contains("scenario-canvas")) return;
    panStart.current = { mx: event.clientX, my: event.clientY, x: pan.x, y: pan.y };
    function onMove(moveEvent) {
      setPan({
        x: panStart.current.x + moveEvent.clientX - panStart.current.mx,
        y: panStart.current.y + moveEvent.clientY - panStart.current.my,
      });
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function handleWheel(event) {
    event.preventDefault();
    const next = zoom - event.deltaY / 650;
    setZoom(Math.max(0.45, Math.min(1.8, next)));
  }

  return (
    <div className="scenario-viewport" ref={viewportRef} onMouseDown={handleMouseDown} onWheel={handleWheel}>
      <div
        className="scenario-canvas"
        style={{
          width: canvasW,
          height: canvasH,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="scenario-edges-svg"
          style={{ position: "absolute", inset: 0, width: canvasW, height: canvasH, overflow: "visible", pointerEvents: "none" }}
        >
          <ArrowDefs />
          {edges.map((edge) => (
            <ScenarioEdge
              key={edge.id}
              edge={edge}
              nodesById={nodesById}
              active={edge.from === currentNodeId}
              editable={editable}
              onDelete={onDeleteEdge}
            />
          ))}
        </svg>
        {nodes.map((node) => (
          <ScenarioNode
            key={node.id}
            node={node}
            isCurrent={node.id === currentNodeId}
            isVisited={visitedNodeIds.includes(node.id)}
            isSelected={node.id === selectedNodeId}
            isStart={node.id === definition.startNodeId}
            editable={editable}
            onSelect={onSelectNode}
            onNavigate={onNavigate}
            onMove={(nodeId, dx, dy) => onMoveNode(nodeId, dx / zoom, dy / zoom)}
          />
        ))}
      </div>
    </div>
  );
}

function EventPanel({
  definition,
  node,
  nodeState,
  runtime,
  editable,
  busy,
  mapTemplates,
  meta,
  onNavigate,
  onSetPhase,
  onStartCombat,
  onEditNode,
  onSetStart,
  onUpdateEdgeLabel,
  onDeleteEdge,
}) {
  if (!node) {
    return (
      <aside className="scenario-event-panel scenario-event-empty">
        <div className="subtle-copy">Select a node.</div>
      </aside>
    );
  }

  const activePhase = getActivePhase(node, nodeState);
  const outgoingEdges = (definition?.edges || []).filter((edge) => edge.from === node.id);
  const selectedPhaseId = nodeState?.phaseId || node.defaultPhaseId || node.phases?.[0]?.id;
  const configuredEnemies = node.combat?.enemies || [];
  const enemyCount = configuredEnemies.reduce((total, entry) => total + (entry.count || 1), 0);
  const mapLabel = node.combat?.mapRef
    ? mapTemplates.find((template) => template.id === node.combat.mapRef)?.name || "Missing map template"
    : "Default arena";

  return (
    <aside className="scenario-event-panel">
      <div className="scenario-event-header">
        <span className={`scenario-node-type-pill scenario-node-type-pill-${node.type}`}>{NODE_LABELS[node.type]}</span>
        <span className="scenario-event-title">{node.label || "Unnamed"}</span>
        {node.id === definition.startNodeId ? <span className="scenario-start-inline">Start</span> : null}
        {editable ? (
          <button className="small-button" type="button" onClick={() => onEditNode(node)}>
            Edit Node
          </button>
        ) : null}
      </div>

      {node.phases?.length > 1 ? (
        <div className="scenario-phase-selector">
          {node.phases.map((phase) => (
            <button
              key={phase.id}
              type="button"
              className={`scenario-phase-btn ${phase.id === selectedPhaseId ? "active" : ""}`.trim()}
              onClick={() => onSetPhase(node.id, phase.id)}
              disabled={busy || editable}
            >
              {phase.label || phase.id}
            </button>
          ))}
        </div>
      ) : null}

      {activePhase?.text ? (
        <div className="scenario-event-text">{activePhase.text}</div>
      ) : (
        <div className="subtle-copy scenario-event-text-empty">No text.</div>
      )}

      {node.type === "combat" ? (
        <div className="scenario-combat-section">
          <div className="scenario-combat-meta">
            <span>{enemyCount ? `${enemyCount} enemies` : "No enemies"}</span>
            <span>{mapLabel}</span>
          </div>
          {configuredEnemies.length ? (
            <div className="scenario-selected-enemy-list scenario-selected-enemy-list-compact">
              {configuredEnemies.map((entry) => {
                const template = findTemplate(meta, entry.templateId);
                return (
                  <div className="scenario-selected-enemy" key={entry.templateId}>
                    {template?.imageUrl ? <img src={template.imageUrl} alt="" aria-hidden="true" /> : <span className="scenario-enemy-fallback" />}
                    <span>{template?.name || entry.templateId}</span>
                    <strong>x{entry.count || 1}</strong>
                  </div>
                );
              })}
            </div>
          ) : null}
          {!editable ? (
            <button className="primary-button" type="button" onClick={() => onStartCombat(node.id)} disabled={busy}>
              {nodeState?.mapInstanceId ? "Open Combat" : "Start Combat"}
            </button>
          ) : null}
          {nodeState?.encounterOutcome ? <div className="scenario-encounter-outcome">Outcome: {nodeState.encounterOutcome}</div> : null}
        </div>
      ) : null}

      {editable ? (
        <div className="scenario-edit-actions">
          <button className="secondary-button" type="button" onClick={() => onSetStart(node.id)} disabled={node.id === definition.startNodeId}>
            Set as start
          </button>
        </div>
      ) : null}

      <div className="scenario-exits">
        <div className="scenario-exits-label">Exits</div>
        {outgoingEdges.length ? outgoingEdges.map((edge) => (
          editable ? (
            <div className="scenario-edge-edit-row" key={edge.id}>
              <input
                value={edge.label || ""}
                onChange={(event) => onUpdateEdgeLabel(edge.id, event.target.value)}
                placeholder="Exit label"
              />
              <button className="save-delete-button" type="button" onClick={() => onDeleteEdge(edge.id)}>
                x
              </button>
            </div>
          ) : (
            <button key={edge.id} type="button" className="scenario-exit-btn" onClick={() => onNavigate(edge.to)} disabled={busy}>
              {edge.label || "Next"}
            </button>
          )
        )) : (
          <div className="subtle-copy">End state.</div>
        )}
      </div>

      {!editable && runtime?.sourceTemplateMissing ? (
        <div className="scenario-source-warning">Source template deleted</div>
      ) : null}
    </aside>
  );
}

function EnemySetupPicker({ meta, entries, onChange }) {
  const templates = meta?.enemyTemplates || [];
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [availability, setAvailability] = useState("spawnable");
  const categories = useMemo(() => ["All", ...unique(templates.map(templateCategory))], [templates]);
  const query = search.trim().toLowerCase();
  const filtered = templates.filter((template) => {
    if (availability === "spawnable" && !isSpawnable(template)) return false;
    if (availability === "design" && isSpawnable(template)) return false;
    if (category !== "All" && templateCategory(template) !== category) return false;
    if (!query) return true;
    const haystack = [
      template.name,
      template.category,
      template.part,
      template.section,
      template.threatTier,
      template.shortFlavour,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(query);
  }).slice(0, 36);

  function addTemplate(template) {
    const existing = entries.find((entry) => entry.templateId === template.id);
    if (existing) {
      onChange(entries.map((entry) => (
        entry.templateId === template.id
          ? { ...entry, count: Math.min(20, (entry.count || 1) + 1) }
          : entry
      )));
    } else {
      onChange([...entries, { templateId: template.id, count: 1 }]);
    }
  }

  function setCount(templateId, count) {
    const normalized = Math.max(1, Math.min(20, Number.parseInt(count, 10) || 1));
    onChange(entries.map((entry) => entry.templateId === templateId ? { ...entry, count: normalized } : entry));
  }

  function remove(templateId) {
    onChange(entries.filter((entry) => entry.templateId !== templateId));
  }

  return (
    <div className="scenario-enemy-picker">
      <div className="scenario-selected-enemy-list">
        {entries.length ? entries.map((entry) => {
          const template = findTemplate(meta, entry.templateId);
          return (
            <div className="scenario-selected-enemy" key={entry.templateId}>
              {template?.imageUrl ? <img src={template.imageUrl} alt="" aria-hidden="true" /> : <span className="scenario-enemy-fallback" />}
              <div className="scenario-selected-enemy-copy">
                <strong>{template?.name || "Unknown enemy"}</strong>
                <span>{[templateCategory(template), templateSection(template), templateThreat(template) != null ? `TL ${templateThreat(template)}` : ""].filter(Boolean).join(" | ")}</span>
              </div>
              <div className="scenario-count-stepper">
                <button type="button" onClick={() => setCount(entry.templateId, (entry.count || 1) - 1)}>-</button>
                <input
                  aria-label={`${template?.name || entry.templateId} count`}
                  type="number"
                  min="1"
                  max="20"
                  value={entry.count || 1}
                  onChange={(event) => setCount(entry.templateId, event.target.value)}
                />
                <button type="button" onClick={() => setCount(entry.templateId, (entry.count || 1) + 1)}>+</button>
              </div>
              <button className="save-delete-button" type="button" onClick={() => remove(entry.templateId)}>x</button>
            </div>
          );
        }) : <div className="subtle-copy">No enemies selected.</div>}
      </div>

      <div className="template-browser-controls scenario-template-browser-controls">
        <input
          className="template-search-field"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search enemies"
        />
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          {categories.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
        </select>
        <div className="template-availability-tabs" role="group" aria-label="Enemy availability">
          <button type="button" className={availability === "spawnable" ? "active" : ""} onClick={() => setAvailability("spawnable")}>Spawnable</button>
          <button type="button" className={availability === "all" ? "active" : ""} onClick={() => setAvailability("all")}>All</button>
          <button type="button" className={availability === "design" ? "active" : ""} onClick={() => setAvailability("design")}>To Design</button>
        </div>
      </div>

      <div className="premade-grid scenario-premade-grid">
        {filtered.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`premade-card ${!isSpawnable(template) ? "premade-card-disabled" : ""}`.trim()}
            onClick={() => addTemplate(template)}
          >
            {template.imageUrl ? (
              <img className="premade-card-art" src={template.imageUrl} alt="" aria-hidden="true" />
            ) : (
              <span className="premade-card-art premade-card-art-placeholder">{String(template.name || "?").charAt(0)}</span>
            )}
            <span className="premade-card-copy">
              <span className="premade-card-kicker">
                {[templateCategory(template), templateThreat(template) != null ? `TL ${templateThreat(template)}` : null].filter(Boolean).join(" | ")}
              </span>
              <span className="premade-card-name">{template.name}</span>
              <span className="premade-card-meta">{templateSection(template)}</span>
              {template.shortFlavour ? <span className="premade-card-flavour">{template.shortFlavour}</span> : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function NodeEditorModal({ node, isStart, mapTemplates, meta, onSave, onDelete, onClose, onRefreshMapTemplates }) {
  const initialNode = normalizeNode(node, 0);
  const [label, setLabel] = useState(initialNode.label);
  const [type, setType] = useState(initialNode.type);
  const [setAsStart, setSetAsStart] = useState(isStart);
  const [phases, setPhases] = useState(initialNode.phases);
  const [activePhaseIndex, setActivePhaseIndex] = useState(0);
  const [defaultPhaseId, setDefaultPhaseId] = useState(initialNode.defaultPhaseId || initialNode.phases[0].id);
  const [mapRef, setMapRef] = useState(initialNode.combat?.mapRef || "");
  const [enemyEntries, setEnemyEntries] = useState(initialNode.combat?.enemies || []);
  const activePhase = phases[activePhaseIndex] || phases[0];

  function updatePhase(index, patch) {
    setPhases((current) => current.map((phase, phaseIndex) => phaseIndex === index ? { ...phase, ...patch } : phase));
  }

  function addPhase() {
    const next = { id: `phase_${Date.now().toString(36)}`, label: `Phase ${phases.length + 1}`, text: "", imageRef: null };
    setPhases((current) => [...current, next]);
    setActivePhaseIndex(phases.length);
  }

  function deletePhase(index) {
    if (phases.length <= 1) return;
    const removed = phases[index];
    const next = phases.filter((_, phaseIndex) => phaseIndex !== index);
    setPhases(next);
    if (removed?.id === defaultPhaseId) {
      setDefaultPhaseId(next[0].id);
    }
    setActivePhaseIndex(Math.max(0, Math.min(index, next.length - 1)));
  }

  function handleSave() {
    const normalizedPhases = phases.map(normalizePhase);
    const phaseIds = new Set(normalizedPhases.map((phase) => phase.id));
    onSave({
      ...node,
      label: label.trim() || NODE_LABELS[type],
      type,
      phases: normalizedPhases,
      defaultPhaseId: phaseIds.has(defaultPhaseId) ? defaultPhaseId : normalizedPhases[0].id,
      combat: type === "combat" ? { enemies: enemyEntries, mapRef: mapRef || null } : null,
    }, { setAsStart });
  }

  return (
    <div className="scenario-modal-overlay" onClick={onClose}>
      <div className="scenario-modal scenario-node-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="scenario-modal-header">
          <span>Edit Node</span>
          <button type="button" className="modal-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="scenario-modal-body">
          <div className="scenario-editor-grid">
            <label className="field">
              <span>Label</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
            </label>
            <label className="field">
              <span>Type</span>
              <select value={type} onChange={(event) => setType(event.target.value)}>
                <option value="scene">Scene</option>
                <option value="combat">Combat</option>
              </select>
            </label>
            <label className="toggle-field scenario-start-toggle">
              <input type="checkbox" checked={setAsStart} onChange={(event) => setSetAsStart(event.target.checked)} />
              <span>Set as start</span>
            </label>
          </div>

          <div className="scenario-phases-editor">
            <div className="scenario-phases-tabs">
              {phases.map((phase, index) => (
                <button
                  key={phase.id}
                  type="button"
                  className={`scenario-phase-tab ${index === activePhaseIndex ? "active" : ""}`.trim()}
                  onClick={() => setActivePhaseIndex(index)}
                >
                  {phase.label || phase.id}
                </button>
              ))}
              <button type="button" className="scenario-phase-add-btn" onClick={addPhase}>+ Phase</button>
            </div>
            {activePhase ? (
              <div className="scenario-phase-edit">
                <div className="scenario-editor-grid">
                  <label className="field">
                    <span>Phase name</span>
                    <input value={activePhase.label || ""} onChange={(event) => updatePhase(activePhaseIndex, { label: event.target.value })} />
                  </label>
                  <div className="scenario-phase-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setDefaultPhaseId(activePhase.id)}
                      disabled={defaultPhaseId === activePhase.id}
                    >
                      {defaultPhaseId === activePhase.id ? "Default phase" : "Set default"}
                    </button>
                    <button
                      type="button"
                      className="small-button danger-button"
                      onClick={() => deletePhase(activePhaseIndex)}
                      disabled={phases.length <= 1}
                    >
                      Delete phase
                    </button>
                  </div>
                </div>
                <label className="field">
                  <span>Text</span>
                  <textarea rows={6} value={activePhase.text || ""} onChange={(event) => updatePhase(activePhaseIndex, { text: event.target.value })} />
                </label>
              </div>
            ) : null}
          </div>

          {type === "combat" ? (
            <div className="scenario-combat-editor">
              <div className="scenario-map-picker">
                <label className="field">
                  <span>Existing map</span>
                  <select value={mapRef} onChange={(event) => setMapRef(event.target.value)}>
                    <option value="">Default open arena</option>
                    {mapTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                </label>
                <button type="button" className="secondary-button" onClick={onRefreshMapTemplates}>
                  Refresh maps
                </button>
              </div>
              {!mapTemplates.length ? (
                <div className="subtle-copy">
                  No saved map templates. Save one from Map Edit first, then refresh this list.
                </div>
              ) : null}
              <div className="form-section-title">Enemies</div>
              <EnemySetupPicker meta={meta} entries={enemyEntries} onChange={setEnemyEntries} />
            </div>
          ) : null}
        </div>
        <div className="scenario-modal-footer">
          <button type="button" className="primary-button" onClick={handleSave}>Save Node</button>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="small-button danger-button" onClick={() => onDelete(node.id)}>Delete node</button>
        </div>
      </div>
    </div>
  );
}

function AddEdgeModal({ nodes, onSave, onClose }) {
  const [from, setFrom] = useState(nodes[0]?.id || "");
  const [to, setTo] = useState(nodes.find((node) => node.id !== from)?.id || nodes[0]?.id || "");
  const [label, setLabel] = useState("");

  function handleSave() {
    if (!from || !to) return;
    onSave({ from, to, label });
  }

  return (
    <div className="scenario-modal-overlay" onClick={onClose}>
      <div className="scenario-modal" onClick={(event) => event.stopPropagation()}>
        <div className="scenario-modal-header">
          <span>Add Edge</span>
          <button type="button" className="modal-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="scenario-modal-body">
          <label className="field">
            <span>From</span>
            <select value={from} onChange={(event) => setFrom(event.target.value)}>
              {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select value={to} onChange={(event) => setTo(event.target.value)}>
              {nodes.map((node) => <option key={node.id} value={node.id}>{node.label || node.id}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
        </div>
        <div className="scenario-modal-footer">
          <button type="button" className="primary-button" onClick={handleSave}>Add Edge</button>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, copy, primary, secondary, tertiary, onClose }) {
  return (
    <div className="scenario-modal-overlay" onClick={onClose}>
      <div className="scenario-modal scenario-confirm-modal" onClick={(event) => event.stopPropagation()}>
        <div className="scenario-modal-header">
          <span>{title}</span>
          <button type="button" className="modal-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="scenario-modal-body">
          <div className="scenario-confirm-copy">{copy}</div>
        </div>
        <div className="scenario-modal-footer">
          {primary ? <button type="button" className="primary-button" onClick={primary.onClick}>{primary.label}</button> : null}
          {secondary ? <button type="button" className="secondary-button" onClick={secondary.onClick}>{secondary.label}</button> : null}
          {tertiary ? <button type="button" className="secondary-button" onClick={tertiary.onClick}>{tertiary.label}</button> : null}
        </div>
      </div>
    </div>
  );
}

export default function ScenarioView({
  snapshot,
  busy,
  setBusy,
  setError,
  setNotice,
  setSnapshot,
  onOpenCombat,
  meta = {},
}) {
  const [scenarios, setScenarios] = useState([]);
  const [mapTemplates, setMapTemplates] = useState([]);
  const [screen, setScreen] = useState(null);
  const [templateDraft, setTemplateDraft] = useState(null);
  const [savedTemplate, setSavedTemplate] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [newScenarioName, setNewScenarioName] = useState("New Scenario");
  const [modal, setModal] = useState(null);
  const [replaceRunScenario, setReplaceRunScenario] = useState(null);
  const [saveChoiceOpen, setSaveChoiceOpen] = useState(false);

  const scenarioRun = getScenarioRun(snapshot);
  const runDefinition = snapshot?.scenario?.definition ? normalizeDefinition(snapshot.scenario.definition) : null;
  const runRuntime = snapshot?.scenario?.runtime || {};
  const activeRun = Boolean(scenarioRun.active);
  const templateDefinition = templateDraft ? normalizeDefinition(templateDraft) : null;
  const activeDefinition = screen === "template" ? templateDefinition : runDefinition;
  const activeRuntime = screen === "template"
    ? { currentNodeId: selectedNodeId || templateDefinition?.startNodeId, visitedNodeIds: [] }
    : runRuntime;
  const dirty = templateDraft && savedTemplate && stableJson(normalizeDefinition(templateDraft)) !== stableJson(normalizeDefinition(savedTemplate));
  const sameTemplateAsActiveRun = Boolean(
    activeRun
    && templateDraft?.id
    && scenarioRun.sourceScenarioId === templateDraft.id
    && !scenarioRun.sourceTemplateMissing,
  );
  const templateRunActionLabel = sameTemplateAsActiveRun
    ? dirty ? "Save & Update Run" : "Continue Run"
    : dirty ? activeRun ? "Save & Replace Run" : "Save & Start Run"
      : activeRun ? "Replace Run" : "Start Run";

  useEffect(() => {
    fetchScenarios();
    fetchMapTemplates();
  }, []);

  useEffect(() => {
    if (!screen) {
      setScreen(activeRun ? "run" : "library");
    }
  }, [activeRun, screen]);

  useEffect(() => {
    if (screen === "run" && runRuntime.currentNodeId) {
      setSelectedNodeId(runRuntime.currentNodeId);
    }
  }, [screen, runRuntime.currentNodeId]);

  useEffect(() => {
    if (screen === "template" && templateDefinition) {
      const nodeIds = new Set(templateDefinition.nodes.map((node) => node.id));
      if (!selectedNodeId || !nodeIds.has(selectedNodeId)) {
        setSelectedNodeId(templateDefinition.startNodeId);
      }
    }
  }, [screen, templateDefinition, selectedNodeId]);

  async function fetchScenarios() {
    try {
      const data = await requestJson("/api/scenarios");
      setScenarios(data.scenarios || []);
    } catch {
      // Library availability is non-fatal for an already open run.
    }
  }

  async function fetchMapTemplates() {
    try {
      const data = await requestJson("/api/map-templates");
      setMapTemplates(data.templates || []);
    } catch {
      // Combat nodes can still use the default arena.
    }
  }

  async function fetchSnapshot() {
    if (!snapshot?.sid) return null;
    const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}`);
    setSnapshot(payload);
    return payload;
  }

  async function runSessionRequest(path, options, successMsg) {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(path, options);
      setSnapshot(payload);
      if (successMsg) setNotice(successMsg);
      return payload;
    } catch (error) {
      setError(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createTemplate(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson("/api/scenarios", {
        method: "POST",
        body: JSON.stringify({ name: newScenarioName }),
      });
      setScenarios(payload.scenarios || []);
      openTemplatePayload(payload.scenario);
      setNotice("Scenario template created");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  function openTemplatePayload(definition) {
    const normalized = cloneDefinition(definition);
    setSavedTemplate(normalized);
    setTemplateDraft(cloneDefinition(normalized));
    setSelectedNodeId(normalized.startNodeId);
    setScreen("template");
  }

  async function editTemplate(scenarioId) {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/scenarios/${encodeURIComponent(scenarioId)}`);
      openTemplatePayload(payload.scenario);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function startRun(scenarioId) {
    const payload = await runSessionRequest(
      `/api/battle/sessions/${snapshot.sid}/scenario/start-run`,
      { method: "POST", body: JSON.stringify({ scenarioId }) },
      "Scenario run started",
    );
    if (payload) {
      setTemplateDraft(null);
      setSavedTemplate(null);
      setScreen("run");
      setReplaceRunScenario(null);
    }
  }

  function requestStartRun(scenario) {
    if (activeRun) {
      setReplaceRunScenario(scenario);
    } else {
      startRun(scenario.id);
    }
  }

  async function saveTemplateOnly() {
    if (!templateDraft) return null;
    setBusy(true);
    setError("");
    try {
      const definition = normalizeDefinition(templateDraft);
      const payload = await requestJson(`/api/scenarios/${encodeURIComponent(definition.id)}`, {
        method: "PUT",
        body: JSON.stringify({ definition }),
      });
      const normalized = cloneDefinition(payload.scenario);
      setSavedTemplate(normalized);
      setTemplateDraft(cloneDefinition(normalized));
      setScenarios(payload.scenarios || scenarios);
      setNotice("Template saved");
      setSaveChoiceOpen(false);
      return normalized;
    } catch (error) {
      setError(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveTemplateAndUpdateRun() {
    if (!templateDraft) return;
    setBusy(true);
    setError("");
    try {
      const definition = normalizeDefinition(templateDraft);
      const payload = await requestJson(`/api/battle/sessions/${snapshot.sid}/scenario/templates/${encodeURIComponent(definition.id)}`, {
        method: "PUT",
        body: JSON.stringify({ definition }),
      });
      setSnapshot(payload);
      const normalized = cloneDefinition(payload.scenarioTemplate || payload.scenario?.definition || definition);
      setSavedTemplate(normalized);
      setTemplateDraft(cloneDefinition(normalized));
      setScenarios(payload.scenarios || scenarios);
      setNotice("Template saved and active run updated");
      setSaveChoiceOpen(false);
      return normalized;
    } catch (error) {
      setError(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runFromTemplateEditor() {
    if (!templateDefinition) return;
    if (sameTemplateAsActiveRun) {
      if (dirty) {
        const updated = await saveTemplateAndUpdateRun();
        if (!updated) return;
      }
      setScreen("run");
      return;
    }
    if (dirty) {
      const saved = await saveTemplateOnly();
      if (!saved) return;
      requestStartRun({ id: saved.id, name: saved.name });
      return;
    }
    requestStartRun({ id: templateDefinition.id, name: templateDefinition.name });
  }

  function handleSaveTemplate() {
    if (sameTemplateAsActiveRun) {
      setSaveChoiceOpen(true);
    } else {
      saveTemplateOnly();
    }
  }

  function discardTemplateChanges() {
    if (!savedTemplate) return;
    const clone = cloneDefinition(savedTemplate);
    setTemplateDraft(clone);
    setSelectedNodeId(clone.startNodeId);
    setNotice("Template changes discarded");
  }

  async function renameTemplate(scenario) {
    const nextName = window.prompt("Rename scenario template", scenario.name);
    if (!nextName || nextName.trim() === scenario.name) return;
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/scenarios/${encodeURIComponent(scenario.id)}/rename`, {
        method: "POST",
        body: JSON.stringify({ name: nextName.trim() }),
      });
      setScenarios(payload.scenarios || []);
      if (templateDraft?.id === scenario.id) {
        openTemplatePayload(payload.scenario);
      }
      setNotice("Template renamed");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function duplicateTemplate(scenario) {
    const nextName = window.prompt("Duplicate scenario template as", `${scenario.name} Copy`);
    if (!nextName) return;
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/scenarios/${encodeURIComponent(scenario.id)}/duplicate`, {
        method: "POST",
        body: JSON.stringify({ name: nextName.trim() }),
      });
      setScenarios(payload.scenarios || []);
      openTemplatePayload(payload.scenario);
      setNotice("Template duplicated");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(scenario) {
    if (!window.confirm(`Delete scenario template "${scenario.name}"?`)) return;
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson(`/api/scenarios/${encodeURIComponent(scenario.id)}`, { method: "DELETE" });
      setScenarios(payload.scenarios || []);
      if (templateDraft?.id === scenario.id) {
        setTemplateDraft(null);
        setSavedTemplate(null);
        setScreen(activeRun ? "run" : "library");
      }
      if (scenarioRun.sourceScenarioId === scenario.id) {
        await fetchSnapshot();
      }
      setNotice("Template deleted");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function navigateNode(nodeId) {
    const payload = await runSessionRequest(
      `/api/battle/sessions/${snapshot.sid}/scenario/navigate`,
      { method: "POST", body: JSON.stringify({ nodeId }) },
    );
    if (payload) setSelectedNodeId(nodeId);
  }

  async function setRunPhase(nodeId, phaseId) {
    if (screen === "template") {
      updateDraftNode(nodeId, (node) => ({ ...node, defaultPhaseId: phaseId }));
      return;
    }
    await runSessionRequest(
      `/api/battle/sessions/${snapshot.sid}/scenario/nodes/${encodeURIComponent(nodeId)}/phase`,
      { method: "POST", body: JSON.stringify({ phaseId }) },
    );
  }

  async function startCombat(nodeId) {
    const payload = await runSessionRequest(
      `/api/battle/sessions/${snapshot.sid}/scenario/nodes/${encodeURIComponent(nodeId)}/start-combat`,
      { method: "POST" },
      "Combat started",
    );
    if (payload) onOpenCombat();
  }

  async function openNodeEditor(node) {
    await fetchMapTemplates();
    setModal({ type: "node", node });
  }

  function updateDraft(updater) {
    setTemplateDraft((current) => normalizeDefinition(updater(cloneDefinition(current))));
  }

  function updateDraftNode(nodeId, updater) {
    updateDraft((definition) => ({
      ...definition,
      nodes: definition.nodes.map((node) => node.id === nodeId ? normalizeNode(updater(node), 0) : node),
    }));
  }

  function moveDraftNode(nodeId, dx, dy) {
    updateDraftNode(nodeId, (node) => ({
      ...node,
      position: {
        x: Math.max(0, (node.position?.x || 0) + dx),
        y: Math.max(0, (node.position?.y || 0) + dy),
      },
    }));
  }

  function addNode(type) {
    const nodeId = `node_${Date.now().toString(36)}`;
    const node = normalizeNode({
      id: nodeId,
      type,
      label: NODE_LABELS[type],
      position: { x: 120 + (templateDefinition?.nodes?.length || 0) * 40, y: 120 + (templateDefinition?.nodes?.length || 0) * 34 },
      phases: [{ id: "phase_default", label: "Default", text: "" }],
      defaultPhaseId: "phase_default",
      combat: type === "combat" ? { enemies: [], mapRef: null } : null,
    }, 0);
    updateDraft((definition) => ({
      ...definition,
      nodes: [...definition.nodes, node],
      startNodeId: definition.startNodeId || node.id,
    }));
    setSelectedNodeId(node.id);
    openNodeEditor(node);
  }

  function saveNode(node, options = {}) {
    updateDraft((definition) => {
      const normalized = normalizeNode(node, 0);
      return {
        ...definition,
        startNodeId: options.setAsStart ? normalized.id : definition.startNodeId,
        nodes: definition.nodes.map((entry) => entry.id === normalized.id ? normalized : entry),
      };
    });
    setSelectedNodeId(node.id);
    setModal(null);
  }

  function deleteNode(nodeId) {
    if (!window.confirm("Delete this node?")) return;
    updateDraft((definition) => {
      const nodes = definition.nodes.filter((node) => node.id !== nodeId);
      const nextNodes = nodes.length ? nodes : [normalizeNode({ id: "start", type: "scene", label: "Start" }, 0)];
      return {
        ...definition,
        nodes: nextNodes,
        edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
        startNodeId: definition.startNodeId === nodeId ? nextNodes[0].id : definition.startNodeId,
      };
    });
    setSelectedNodeId((current) => current === nodeId ? null : current);
    setModal(null);
  }

  function setStartNode(nodeId) {
    updateDraft((definition) => ({ ...definition, startNodeId: nodeId }));
  }

  function addEdge(edge) {
    updateDraft((definition) => ({
      ...definition,
      edges: [...definition.edges, { id: `edge_${Date.now().toString(36)}`, ...edge, condition: null }],
    }));
    setModal(null);
  }

  function updateEdgeLabel(edgeId, label) {
    updateDraft((definition) => ({
      ...definition,
      edges: definition.edges.map((edge) => edge.id === edgeId ? { ...edge, label } : edge),
    }));
  }

  function deleteEdge(edgeId) {
    updateDraft((definition) => ({ ...definition, edges: definition.edges.filter((edge) => edge.id !== edgeId) }));
  }

  const selectedNode = activeDefinition?.nodes?.find((node) => node.id === selectedNodeId)
    || activeDefinition?.nodes?.find((node) => node.id === activeDefinition.startNodeId)
    || activeDefinition?.nodes?.[0]
    || null;
  const selectedNodeState = screen === "template" ? null : runRuntime.nodeStates?.[selectedNode?.id] || null;

  if (screen === "library" || !screen) {
    return (
      <div className="scenario-view scenario-library-view">
        <div className="scenario-toolbar">
          <span className="scenario-title">Scenario Library</span>
          {activeRun ? (
            <button type="button" className="primary-button" onClick={() => setScreen("run")}>
              Continue Run
            </button>
          ) : null}
          {activeRun && scenarioRun.sourceTemplateMissing ? <span className="scenario-source-warning">Source template deleted</span> : null}
        </div>

        <div className="scenario-library-layout">
          <section className="panel scenario-library-panel">
            <div className="panel-header">
              <div>
                <div className="panel-title">Templates</div>
                <div className="panel-detail">{scenarios.length} saved</div>
              </div>
            </div>
            <div className="panel-body">
              <form className="scenario-create-form" onSubmit={createTemplate}>
                <input value={newScenarioName} onChange={(event) => setNewScenarioName(event.target.value)} placeholder="Scenario name" />
                <button type="submit" className="primary-button" disabled={busy}>Create Template</button>
              </form>
              <div className="save-list scenario-template-list">
                {scenarios.length ? scenarios.map((scenario) => (
                  <div className="save-row scenario-template-row" key={scenario.id}>
                    <div className="save-slot-info">
                      <span className="save-slot-title">{scenario.name}</span>
                      <span className="save-slot-meta">{scenario.nodeCount || 0} nodes | {scenario.edgeCount || 0} edges</span>
                    </div>
                    <div className="scenario-template-actions">
                      <button type="button" className="small-button" onClick={() => editTemplate(scenario.id)} disabled={busy}>Edit Template</button>
                      <button type="button" className="small-button" onClick={() => requestStartRun(scenario)} disabled={busy}>Start Run</button>
                      <button type="button" className="small-button" onClick={() => renameTemplate(scenario)} disabled={busy}>Rename</button>
                      <button type="button" className="small-button" onClick={() => duplicateTemplate(scenario)} disabled={busy}>Duplicate</button>
                      <button
                        type="button"
                        className="icon-button scenario-icon-delete"
                        onClick={() => deleteTemplate(scenario)}
                        disabled={busy}
                        aria-label={`Delete ${scenario.name}`}
                        title="Delete"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  </div>
                )) : <div className="subtle-copy">No templates.</div>}
              </div>
            </div>
          </section>

          {activeRun ? (
            <section className="panel scenario-run-card">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Active Run</div>
                  <div className="panel-detail">
                    {scenarioRun.sourceTemplateMissing ? "Source template deleted" : scenarioRun.sourceScenarioName}
                  </div>
                </div>
              </div>
              <div className="panel-body">
                <button type="button" className="primary-button" onClick={() => setScreen("run")}>Continue Run</button>
              </div>
            </section>
          ) : null}
        </div>

        {replaceRunScenario ? (
          <ConfirmModal
            title="Replace active run?"
            copy={`Start a new run from "${replaceRunScenario.name}" and replace the current active run.`}
            primary={{ label: "Replace Run", onClick: () => startRun(replaceRunScenario.id) }}
            secondary={{ label: "Cancel", onClick: () => setReplaceRunScenario(null) }}
            onClose={() => setReplaceRunScenario(null)}
          />
        ) : null}
      </div>
    );
  }

  if (screen === "template" && templateDefinition) {
    return (
      <div className="scenario-view">
        <div className="scenario-toolbar">
          <span className="scenario-title">Edit Template</span>
          <input
            className="scenario-title-input"
            value={templateDraft.name || ""}
            onChange={(event) => updateDraft((definition) => ({ ...definition, name: event.target.value }))}
          />
          {dirty ? <span className="scenario-dirty-badge">Unsaved changes</span> : null}
          <button type="button" className="primary-button" onClick={handleSaveTemplate} disabled={busy || !dirty}>Save Template</button>
          <button type="button" className="secondary-button" onClick={discardTemplateChanges} disabled={busy || !dirty}>Discard</button>
          <button type="button" className="menu-button" onClick={runFromTemplateEditor} disabled={busy}>
            {templateRunActionLabel}
          </button>
          <div className="scenario-toolbar-divider" />
          <button type="button" className="menu-button" onClick={() => addNode("scene")} disabled={busy}>+ Scene</button>
          <button type="button" className="menu-button" onClick={() => addNode("combat")} disabled={busy}>+ Combat</button>
          <button type="button" className="menu-button" onClick={() => setModal({ type: "edge" })} disabled={busy || templateDefinition.nodes.length < 2}>+ Edge</button>
          <button type="button" className="menu-button" onClick={() => setScreen("library")}>Library</button>
        </div>

        <div className="scenario-main">
          <FlowOverview
            definition={templateDefinition}
            runtime={activeRuntime}
            editable
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onNavigate={setSelectedNodeId}
            onMoveNode={moveDraftNode}
            onDeleteEdge={deleteEdge}
          />
          <EventPanel
            definition={templateDefinition}
            node={selectedNode}
            nodeState={selectedNodeState}
            runtime={activeRuntime}
            editable
            busy={busy}
            mapTemplates={mapTemplates}
            meta={meta}
            onNavigate={setSelectedNodeId}
            onSetPhase={setRunPhase}
            onStartCombat={startCombat}
            onEditNode={openNodeEditor}
            onSetStart={setStartNode}
            onUpdateEdgeLabel={updateEdgeLabel}
            onDeleteEdge={deleteEdge}
          />
        </div>

        {modal?.type === "node" ? (
          <NodeEditorModal
            node={templateDefinition.nodes.find((node) => node.id === modal.node.id) || modal.node}
            isStart={templateDefinition.startNodeId === modal.node.id}
            mapTemplates={mapTemplates}
            meta={meta}
            onSave={saveNode}
            onDelete={deleteNode}
            onClose={() => setModal(null)}
            onRefreshMapTemplates={fetchMapTemplates}
          />
        ) : null}
        {modal?.type === "edge" ? <AddEdgeModal nodes={templateDefinition.nodes} onSave={addEdge} onClose={() => setModal(null)} /> : null}
        {saveChoiceOpen ? (
          <ConfirmModal
            title="Save Template"
            copy="This template has an active run."
            primary={{ label: "Save template only", onClick: saveTemplateOnly }}
            secondary={{ label: "Save template and update active run", onClick: saveTemplateAndUpdateRun }}
            tertiary={{ label: "Cancel", onClick: () => setSaveChoiceOpen(false) }}
            onClose={() => setSaveChoiceOpen(false)}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="scenario-view">
      <div className="scenario-toolbar">
        <span className="scenario-title">Continue Run</span>
        <span className="pill pill-muted">
          {scenarioRun.sourceTemplateMissing ? "Source template deleted" : scenarioRun.sourceScenarioName || runDefinition?.name || "Scenario"}
        </span>
        <button type="button" className="menu-button" onClick={() => setScreen("library")}>Library</button>
        {!scenarioRun.sourceTemplateMissing && scenarioRun.sourceScenarioId ? (
          <button type="button" className="menu-button" onClick={() => editTemplate(scenarioRun.sourceScenarioId)} disabled={busy}>
            Edit Template
          </button>
        ) : null}
      </div>

      {runDefinition ? (
        <div className="scenario-main">
          <FlowOverview
            definition={runDefinition}
            runtime={runRuntime}
            editable={false}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onNavigate={navigateNode}
            onMoveNode={() => {}}
            onDeleteEdge={() => {}}
          />
          <EventPanel
            definition={runDefinition}
            node={selectedNode}
            nodeState={selectedNodeState}
            runtime={scenarioRun}
            editable={false}
            busy={busy}
            mapTemplates={mapTemplates}
            meta={meta}
            onNavigate={navigateNode}
            onSetPhase={setRunPhase}
            onStartCombat={startCombat}
            onEditNode={() => {}}
            onSetStart={() => {}}
            onUpdateEdgeLabel={() => {}}
            onDeleteEdge={() => {}}
          />
        </div>
      ) : (
        <div className="scenario-empty">
          <div className="scenario-empty-content">
            <div className="scenario-empty-title">No active run</div>
            <button type="button" className="primary-button" onClick={() => setScreen("library")}>Scenario Library</button>
          </div>
        </div>
      )}
    </div>
  );
}
