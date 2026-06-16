(function () {
  var vscode = acquireVsCodeApi();

  /* ------------------------------------------------------------------ *
   * Register third-party cytoscape extensions (fcose)
   * ------------------------------------------------------------------ */
  if (typeof window.cytoscape === "function") {
    if (window.cytoscapeFcose) { window.cytoscape.use(window.cytoscapeFcose); }
  }

  /* ------------------------------------------------------------------ *
   * Service catalog (colors + human labels + compact badges)
   * ------------------------------------------------------------------ */
  var SERVICE_COLORS = {
    ec2: "#FF9900", s3: "#3F8624", iam: "#DD344C", lambda: "#D86613",
    ecs: "#ED7100", ecr: "#ED7100", rds: "#527FFF", dynamodb: "#4053D6",
    redshift: "#8C4FFF", eventbridge: "#E7157B", msk: "#C7131F",
    vpc: "#8C4FFF", kms: "#DD344C", elbv2: "#8C4FFF", cloudformation: "#E7157B"
  };
  var SERVICE_LABELS = {
    ec2: "EC2", s3: "S3", iam: "IAM", lambda: "Lambda", ecs: "ECS",
    ecr: "ECR", rds: "RDS", dynamodb: "DynamoDB", redshift: "Redshift",
    eventbridge: "EventBridge", msk: "MSK", vpc: "VPC", kms: "KMS",
    elbv2: "ELB", cloudformation: "CFN"
  };
  var SERVICE_BADGE = {
    ec2: "EC2", s3: "S3", iam: "IAM", lambda: "Fn", ecs: "ECS", ecr: "ECR",
    rds: "RDS", dynamodb: "DDB", redshift: "RS", eventbridge: "EB",
    msk: "MSK", vpc: "VPC", kms: "KMS", elbv2: "ELB", cloudformation: "CFN"
  };
  function getColor(service) { return SERVICE_COLORS[service] || "#8a94a6"; }

  /** Recover account / region from a standard AWS ARN when payload fields are empty. */
  function inferScopeFromArn(arn) {
    if (!arn || String(arn).indexOf("arn:") !== 0) return {};
    var parts = String(arn).split(":");
    if (parts.length < 6) return {};
    var reg = parts[3];
    var acct = parts[4];
    var accountId = /^\d{12}$/.test(acct || "") ? acct : undefined;
    var region = reg && reg.length > 0 && reg !== "*" ? reg : undefined;
    return { accountId: accountId, region: region };
  }

  function getBadge(service) {
    if (!service) return "";
    return SERVICE_BADGE[service] || service.slice(0, 3).toUpperCase();
  }

  /* ------------------------------------------------------------------ *
   * Edge relationship → visual category (for color / dash styling)
   * ------------------------------------------------------------------ */
  var EDGE_CATEGORIES = {
    network:     { label: "Network",     color: "#527FFF", style: "solid"  },
    identity:    { label: "Identity",    color: "#DD344C", style: "solid"  },
    encryption:  { label: "Encryption",  color: "#8C4FFF", style: "dashed" },
    containment: { label: "Containment", color: "#6b7280", style: "solid"  },
    messaging:   { label: "Messaging",   color: "#E7157B", style: "solid"  },
    other:       { label: "Other",       color: "#9aa1ac", style: "dotted" }
  };
  function edgeCategory(relationship) {
    var r = String(relationship || "").toLowerCase();
    if (r === "vpc" || r === "subnet" || r === "subnets" || r === "security-groups" || r === "route-table") return "network";
    if (r === "iam-role" || r === "iam-policy" || r === "assume-role") return "identity";
    if (r === "kms-key" || r === "encryption-key") return "encryption";
    if (r === "ecs-cluster" || r === "cluster" || r === "contains") return "containment";
    if (r === "event-bus" || r === "event-source" || r === "triggers" || r === "trigger") return "messaging";
    return "other";
  }

  /* ------------------------------------------------------------------ *
   * View state
   * ------------------------------------------------------------------ */
  var cy = null;
  var hoverTooltipEl = null;
  var contextMenuEl = null;
  var activeServiceFilter = "";
  var state = {
    rawNodes: [],          // payload.nodes from last replace + appends
    rawEdges: [],          // payload.edges from last replace + appends
    rootArn: "",
    groupMode: "none",     // none | region | account | account-region
    depth: 3,
    focusModeEnabled: false,
    focusArn: "",
    hiddenIds: new Set(),
    lastRefreshTs: 0
  };

  /* ------------------------------------------------------------------ *
   * Layout (fcose only; falls back to cose if fcose isn't registered)
   * ------------------------------------------------------------------ */
  function buildLayoutOptions() {
    return {
      name: "fcose",
      quality: "default",
      animate: true,
      animationDuration: 400,
      randomize: false,
      packComponents: true,
      nodeRepulsion: 6500,
      idealEdgeLength: 90,
      nodeSeparation: 60,
      gravity: 0.25,
      gravityRangeCompound: 1.5,
      nestingFactor: 0.1,
      padding: 40,
      fit: true
    };
  }

  function runLayout() {
    if (!cy) return;
    try {
      cy.layout(buildLayoutOptions()).run();
    } catch (err) {
      cy.layout({
        name: "cose",
        animate: true,
        animationDuration: 400,
        randomize: false,
        nodeRepulsion: 16000,
        idealEdgeLength: 110,
        gravity: 0.15,
        padding: 50,
        fit: true
      }).run();
    }
  }

  /* ------------------------------------------------------------------ *
   * Cytoscape init + styling
   * ------------------------------------------------------------------ */
  function initCytoscape() {
    cy = cytoscape({
      container: document.getElementById("graph"),
      wheelSensitivity: 0.3,
      minZoom: 0.1,
      maxZoom: 5,
      style: buildStylesheet(),
      elements: [],
      layout: { name: "preset" }
    });

    bindGraphEvents();
    vscode.postMessage({ type: "ready" });
  }

  function buildStylesheet() {
    var edgeStyles = [];
    Object.keys(EDGE_CATEGORIES).forEach(function (key) {
      var cat = EDGE_CATEGORIES[key];
      edgeStyles.push({
        selector: 'edge[category = "' + key + '"]',
        style: {
          "line-color": cat.color,
          "target-arrow-color": cat.color,
          "line-style": cat.style === "dotted" ? "dotted" : cat.style === "dashed" ? "dashed" : "solid",
          "line-opacity": 0.75
        }
      });
      edgeStyles.push({
        selector: 'edge.highlighted[category = "' + key + '"]',
        style: {
          "line-color": cat.color,
          "target-arrow-color": cat.color,
          "line-opacity": 1,
          width: 2
        }
      });
    });

    return [
      {
        selector: "node",
        style: {
          label: "data(label)",
          shape: "roundrectangle",
          "background-color": "#eceff3",
          "background-opacity": 1,
          "border-width": 1,
          "border-color": "#d4d8de",
          "border-opacity": 1,
          width: 78,
          height: 30,
          padding: "6px",
          "text-valign": "center",
          "text-halign": "center",
          "font-size": "10px",
          "font-weight": "600",
          "text-wrap": "ellipsis",
          "text-max-width": "72px",
          color: "#4b5563",
          "overlay-padding": 4
        }
      },
      {
        selector: "node.root",
        style: {
          "background-color": "#dfe3ea",
          "border-width": 1.5,
          "border-color": "data(color)",
          color: "#1f2937",
          "font-weight": "700"
        }
      },
      {
        selector: "node:selected",
        style: {
          "border-width": 2,
          "border-color": "#3b82f6",
          "background-color": "#e4ecfb",
          color: "#1e3a8a"
        }
      },
      {
        selector: "node.highlighted",
        style: {
          "border-width": 2,
          "border-color": "data(color)",
          "background-color": "#ffffff",
          color: "#111827",
          "font-weight": "700",
          "z-index": 100
        }
      },
      {
        selector: "node.hover-focus",
        style: {
          "border-color": "data(color)",
          "border-width": 1.5,
          "background-color": "#ffffff",
          color: "#111827",
          "z-index": 80
        }
      },
      {
        selector: "node.dimmed",
        style: { opacity: 0.18 }
      },
      /* ── Compound parent nodes (groupings) ── */
      {
        selector: "node.group",
        style: {
          label: "data(groupLabel)",
          shape: "roundrectangle",
          "background-color": "#f3f4f6",
          "background-opacity": 0.55,
          "border-width": 1,
          "border-style": "dashed",
          "border-color": "#c6cbd2",
          color: "#6b7280",
          "font-size": "10px",
          "font-weight": "700",
          "text-transform": "uppercase",
          "text-valign": "top",
          "text-halign": "left",
          "text-margin-x": 10,
          "text-margin-y": 6,
          padding: "22px",
          "z-compound-depth": "bottom",
          "text-wrap": "wrap",
          "text-max-width": "520px"
        }
      },
      {
        selector: "node.group-account",
        style: {
          "background-color": "#eef2ff",
          "border-color": "#bbc5e8",
          color: "#4c51bf"
        }
      },
      /* ── Edges (base) ── */
      {
        selector: "edge",
        style: {
          width: 1.25,
          "line-color": "#c4c9d1",
          "line-opacity": 0.85,
          "target-arrow-color": "#9aa1ac",
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.9,
          "curve-style": "bezier",
          "control-point-step-size": 30,
          label: "data(label)",
          "font-size": "9px",
          "font-weight": "500",
          "text-rotation": "autorotate",
          "text-margin-y": -8,
          color: "#8a919c",
          "text-background-color": "#f4f5f7",
          "text-background-opacity": 1,
          "text-background-padding": "2px",
          "text-background-shape": "roundrectangle"
        }
      },
      {
        selector: "edge.dimmed",
        style: { opacity: 0.08 }
      },
      {
        selector: "edge.highlighted",
        style: {
          "line-opacity": 1,
          width: 1.75,
          "z-index": 50
        }
      }
    ].concat(edgeStyles);
  }

  function bindGraphEvents() {
    cy.on("tap", "node", function (event) {
      var node = event.target;
      if (node.hasClass("group")) return;
      var arn = node.data("arn");
      if (!arn) return;
      vscode.postMessage({ type: "requestDetails", arn: arn });
      if (state.focusModeEnabled) {
        applyFocusNeighborhood(node);
      }
    });

    cy.on("dbltap", "node", function (event) {
      var node = event.target;
      if (node.hasClass("group")) return;
      var arn = node.data("arn");
      if (!arn) return;
      vscode.postMessage({ type: "expand", arn: arn, depth: state.depth });
    });

    cy.on("mouseover", "node", function (event) {
      var node = event.target;
      if (node.hasClass("group")) { return; }
      applyHoverFocus(node);
      showHoverTooltip(node, event.originalEvent);
    });

    cy.on("mousemove", "node", function (event) {
      var node = event.target;
      if (node.hasClass("group")) { return; }
      positionHoverTooltip(event.originalEvent);
    });

    cy.on("mouseout", "node", function () {
      clearHoverFocus();
      hideHoverTooltip();
    });

    cy.on("cxttap", "node", function (event) {
      var node = event.target;
      if (node.hasClass("group")) return;
      showContextMenu(node, event.originalEvent);
    });

    cy.on("tap", function (event) {
      if (event.target === cy) {
        hideHoverTooltip();
        hideContextMenu();
        if (state.focusModeEnabled && state.focusArn) {
          clearFocusNeighborhood();
        }
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Hover tooltip
   * ------------------------------------------------------------------ */
  function applyHoverFocus(node) {
    if (state.focusArn) return; // don't interfere with pinned focus
    var neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).not(".group").addClass("dimmed");
    node.addClass("hover-focus");
  }

  function clearHoverFocus() {
    if (state.focusArn) return;
    cy.elements().removeClass("dimmed");
    cy.nodes().removeClass("hover-focus");
    if (activeServiceFilter || (document.getElementById("search-input").value || "").trim()) {
      applyFilters();
    }
  }

  function ensureTooltipEl() {
    if (!hoverTooltipEl) {
      hoverTooltipEl = document.createElement("div");
      hoverTooltipEl.id = "node-tooltip";
      document.body.appendChild(hoverTooltipEl);
    }
    return hoverTooltipEl;
  }

  function showHoverTooltip(node, mouseEvent) {
    var el = ensureTooltipEl();
    var svc = node.data("service") || "";
    var type = node.data("type") || "";
    var arn = node.data("arn") || "";
    var region = node.data("region") || "";
    var account = node.data("accountId") || "";
    var tail = arn.length > 48 ? "\u2026" + arn.slice(-46) : arn;
    var label = SERVICE_LABELS[svc] || (svc ? svc.toUpperCase() : "");
    var scope = [region, account].filter(Boolean).join(" \u00B7 ");
    el.innerHTML =
      '<div class="tt-row"><span class="tt-dot" style="background:' + getColor(svc) + '"></span>' +
      '<span class="tt-service">' + escapeHtml(label) + '</span>' +
      '<span class="tt-type">' + escapeHtml(type) + '</span></div>' +
      '<div class="tt-name">' + escapeHtml(node.data("rawLabel") || node.data("label") || "") + '</div>' +
      (scope ? '<div class="tt-scope">' + escapeHtml(scope) + '</div>' : "") +
      '<div class="tt-arn">' + escapeHtml(tail) + '</div>';
    el.classList.add("visible");
    positionHoverTooltip(mouseEvent);
  }

  function positionHoverTooltip(mouseEvent) {
    if (!hoverTooltipEl || !mouseEvent) return;
    var x = mouseEvent.clientX + 14;
    var y = mouseEvent.clientY + 14;
    var maxX = window.innerWidth - hoverTooltipEl.offsetWidth - 10;
    var maxY = window.innerHeight - hoverTooltipEl.offsetHeight - 10;
    hoverTooltipEl.style.left = Math.min(x, maxX) + "px";
    hoverTooltipEl.style.top = Math.min(y, maxY) + "px";
  }

  function hideHoverTooltip() {
    if (hoverTooltipEl) hoverTooltipEl.classList.remove("visible");
  }

  /* ------------------------------------------------------------------ *
   * Focus mode — pin a node's neighborhood, ESC restores.
   * ------------------------------------------------------------------ */
  function applyFocusNeighborhood(node) {
    if (!cy || !node || node.empty()) return;
    state.focusArn = node.data("arn");
    var nhood = node.closedNeighborhood();
    cy.elements().removeClass("dimmed hover-focus");
    cy.elements().not(nhood).not(".group").addClass("dimmed");
    node.addClass("highlighted");
  }

  function clearFocusNeighborhood() {
    state.focusArn = "";
    if (!cy) return;
    cy.elements().removeClass("dimmed");
    cy.nodes().removeClass("highlighted hover-focus");
    if (state.rootArn) {
      var rootNode = cy.getElementById(state.rootArn);
      if (rootNode.nonempty()) rootNode.addClass("root");
    }
    applyFilters();
  }

  /* ------------------------------------------------------------------ *
   * Context menu
   * ------------------------------------------------------------------ */
  function ensureContextMenuEl() {
    if (!contextMenuEl) {
      contextMenuEl = document.getElementById("context-menu");
    }
    return contextMenuEl;
  }

  function showContextMenu(node, mouseEvent) {
    var el = ensureContextMenuEl();
    if (!el || !mouseEvent) return;
    var arn = node.data("arn");
    var items = [
      { id: "details",   label: "Open details" },
      { id: "expand",    label: "Expand neighbors (depth " + state.depth + ")" },
      { id: "isolate",   label: "Isolate neighborhood" },
      { id: "copy-arn",  label: "Copy ARN" },
      { id: "hide",      label: "Hide from graph" }
    ];
    if (state.hiddenIds.size > 0) {
      items.push({ id: "unhide-all", label: "Show all hidden (" + state.hiddenIds.size + ")" });
    }
    el.innerHTML = items.map(function (item) {
      return '<div class="ctx-item" data-action="' + item.id + '">' + escapeHtml(item.label) + "</div>";
    }).join("");

    el.style.display = "block";
    el.classList.add("visible");
    var x = mouseEvent.clientX;
    var y = mouseEvent.clientY;
    // Defer position until we have real dimensions.
    requestAnimationFrame(function () {
      var w = el.offsetWidth;
      var h = el.offsetHeight;
      if (x + w > window.innerWidth - 10) x = window.innerWidth - w - 10;
      if (y + h > window.innerHeight - 10) y = window.innerHeight - h - 10;
      el.style.left = x + "px";
      el.style.top = y + "px";
    });

    Array.prototype.forEach.call(el.querySelectorAll(".ctx-item"), function (item) {
      item.addEventListener("click", function () {
        handleContextAction(item.getAttribute("data-action"), arn, node);
        hideContextMenu();
      });
    });
  }

  function hideContextMenu() {
    if (!contextMenuEl) return;
    contextMenuEl.classList.remove("visible");
    contextMenuEl.style.display = "none";
    contextMenuEl.innerHTML = "";
  }

  function handleContextAction(action, arn, node) {
    if (!arn || !cy) return;
    switch (action) {
      case "details":
        vscode.postMessage({ type: "requestDetails", arn: arn });
        break;
      case "expand":
        vscode.postMessage({ type: "expand", arn: arn, depth: state.depth });
        break;
      case "isolate":
        applyFocusNeighborhood(node);
        break;
      case "copy-arn":
        vscode.postMessage({ type: "copyArn", arn: arn });
        if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(arn).catch(function () { /* ignore */ });
        }
        break;
      case "hide":
        state.hiddenIds.add(arn);
        node.connectedEdges().remove();
        node.remove();
        updateCountsAndFilters();
        break;
      case "unhide-all":
        state.hiddenIds.clear();
        rebuildGraph();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ *
   * Graph (re)build — compound groupings, edge categories, filters
   * ------------------------------------------------------------------ */
  function mergeIncomingPayload(payload, replace) {
    if (replace) {
      state.rawNodes = (payload.nodes || []).slice();
      state.rawEdges = (payload.edges || []).slice();
      state.rootArn = payload.rootArn || "";
      state.hiddenIds = new Set();
      state.focusArn = "";
    } else {
      var existingNodes = new Set(state.rawNodes.map(function (n) { return n.arn; }));
      (payload.nodes || []).forEach(function (n) {
        if (!existingNodes.has(n.arn)) state.rawNodes.push(n);
      });
      var existingEdges = new Set(state.rawEdges.map(function (e) { return e.id; }));
      (payload.edges || []).forEach(function (e) {
        if (!existingEdges.has(e.id)) state.rawEdges.push(e);
      });
    }
    state.lastRefreshTs = Date.now();
  }

  function rebuildGraph() {
    if (!cy) return;
    var elements = buildElementsForCurrentState();
    cy.startBatch();
    cy.elements().remove();
    cy.add(elements);
    if (state.rootArn) {
      var root = cy.getElementById(state.rootArn);
      if (root.nonempty()) root.addClass("root");
    }
    cy.endBatch();
    runLayout();
    buildServiceFilterOptions();
    buildAccountRegionFilterOptions();
    buildLegend();
    updateStatusBar();
    applyFilters();
  }

  function buildElementsForCurrentState() {
    var els = [];
    var addedGroups = new Set();
    var visibleNodes = state.rawNodes.filter(function (n) { return !state.hiddenIds.has(n.arn); });

    visibleNodes.forEach(function (n) {
      var inf = inferScopeFromArn(n.arn);
      var accountId = n.accountId || inf.accountId || "";
      var region = n.region || inf.region || "";
      var parentId = resolveParentId(accountId, region, addedGroups, els);
      var badge = getBadge(n.service);
      var displayLabel = (badge ? badge + "  " : "") + n.label;
      var data = {
        id: n.arn,
        arn: n.arn,
        label: displayLabel,
        rawLabel: n.label,
        service: n.service,
        type: n.type,
        accountId: accountId,
        region: region,
        color: getColor(n.service)
      };
      if (parentId) data.parent = parentId;
      els.push({ group: "nodes", data: data });
    });

    var visibleIds = new Set(visibleNodes.map(function (n) { return n.arn; }));
    state.rawEdges.forEach(function (e) {
      if (!visibleIds.has(e.source) || !visibleIds.has(e.target)) return;
      var cat = edgeCategory(e.label);
      els.push({
        group: "edges",
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          category: cat
        }
      });
    });

    return els;
  }

  function resolveParentId(account, region, addedGroups, els) {
    if (state.groupMode === "none") return null;

    region = region || "unknown";
    account = account || "unknown";

    if (state.groupMode === "region") {
      var id = "__grp::region::" + region;
      addGroupNode(addedGroups, els, {
        id: id,
        groupLabel: "Region \u00B7 " + region,
        classes: "group"
      });
      return id;
    }

    if (state.groupMode === "account") {
      var idA = "__grp::account::" + account;
      addGroupNode(addedGroups, els, {
        id: idA,
        groupLabel: "Account \u00B7 " + account,
        classes: "group group-account"
      });
      return idA;
    }

    if (state.groupMode === "account-region") {
      var accId = "__grp::account::" + account;
      var regId = "__grp::account::" + account + "::region::" + region;
      addGroupNode(addedGroups, els, {
        id: accId,
        groupLabel: "Account \u00B7 " + account,
        classes: "group group-account"
      });
      addGroupNode(addedGroups, els, {
        id: regId,
        groupLabel: "Region \u00B7 " + region,
        parent: accId,
        classes: "group"
      });
      return regId;
    }

    return null;
  }

  function addGroupNode(addedGroups, els, spec) {
    if (addedGroups.has(spec.id)) return;
    addedGroups.add(spec.id);
    var data = { id: spec.id, groupLabel: spec.groupLabel };
    if (spec.parent) data.parent = spec.parent;
    els.push({ group: "nodes", data: data, classes: spec.classes });
  }

  /* ------------------------------------------------------------------ *
   * Legend (services + edge categories)
   * ------------------------------------------------------------------ */
  function buildLegend() {
    var legendEl = document.getElementById("graph-legend");
    if (!cy || !legendEl) return;
    var services = {};
    cy.nodes().not(".group").forEach(function (n) {
      var svc = n.data("service");
      if (svc) services[svc] = true;
    });
    var html = '<div class="legend-section"><span class="legend-heading">Services</span>';
    Object.keys(services).sort().forEach(function (svc) {
      var color = getColor(svc);
      var label = SERVICE_LABELS[svc] || svc.toUpperCase();
      html += '<div class="legend-item" data-service="' + svc + '">';
      html += '<div class="legend-dot" style="background:' + color + ';"></div>';
      html += '<span class="legend-label">' + label + '</span>';
      html += '</div>';
    });
    html += '</div>';

    var cats = {};
    cy.edges().forEach(function (e) {
      var c = e.data("category");
      if (c) cats[c] = true;
    });
    var catKeys = Object.keys(cats);
    if (catKeys.length > 0) {
      html += '<div class="legend-section"><span class="legend-heading">Relationships</span>';
      catKeys.forEach(function (key) {
        var c = EDGE_CATEGORIES[key];
        if (!c) return;
        html += '<div class="legend-item legend-item-edge">';
        html += '<span class="legend-line legend-line-' + c.style + '" style="background:' + c.color + ';"></span>';
        html += '<span class="legend-label">' + escapeHtml(c.label) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }

    legendEl.innerHTML = html;

    Array.prototype.forEach.call(legendEl.querySelectorAll(".legend-item[data-service]"), function (item) {
      item.addEventListener("click", function () {
        var svc = item.getAttribute("data-service");
        var filterEl = document.getElementById("service-filter");
        if (activeServiceFilter === svc) {
          activeServiceFilter = "";
          filterEl.value = "";
        } else {
          activeServiceFilter = svc;
          filterEl.value = svc;
        }
        applyFilters();
      });
    });
  }

  function buildAccountRegionFilterOptions() {
    var accEl = document.getElementById("account-filter");
    var regEl = document.getElementById("region-filter");
    if (!accEl || !regEl) return;

    var accounts = {};
    var regions = {};
    state.rawNodes.forEach(function (n) {
      var inf = inferScopeFromArn(n.arn);
      var a = n.accountId || inf.accountId;
      var r = n.region || inf.region;
      if (a) accounts[a] = (accounts[a] || 0) + 1;
      if (r) regions[r] = (regions[r] || 0) + 1;
    });

    var accPrev = accEl.value;
    var regPrev = regEl.value;
    var accKeys = Object.keys(accounts).sort();
    var regKeys = Object.keys(regions).sort();

    var accHtml = '<option value="">All accounts</option>';
    accKeys.forEach(function (a) {
      accHtml += '<option value="' + escapeHtml(a) + '">' + escapeHtml(a) + " (" + accounts[a] + ")</option>";
    });
    accEl.innerHTML = accHtml;
    if (accPrev && accounts[accPrev]) accEl.value = accPrev; else accEl.value = "";

    var regHtml = '<option value="">All regions</option>';
    regKeys.forEach(function (r) {
      regHtml += '<option value="' + escapeHtml(r) + '">' + escapeHtml(r) + " (" + regions[r] + ")</option>";
    });
    regEl.innerHTML = regHtml;
    if (regPrev && regions[regPrev]) regEl.value = regPrev; else regEl.value = "";
  }

  function buildServiceFilterOptions() {
    var filterEl = document.getElementById("service-filter");
    if (!cy || !filterEl) return;
    var services = {};
    cy.nodes().not(".group").forEach(function (n) {
      var svc = n.data("service");
      if (svc) services[svc] = (services[svc] || 0) + 1;
    });
    var html = '<option value="">All Services</option>';
    Object.keys(services).sort().forEach(function (svc) {
      var label = SERVICE_LABELS[svc] || svc.toUpperCase();
      html += '<option value="' + svc + '">' + label + ' (' + services[svc] + ')</option>';
    });
    var prev = filterEl.value;
    filterEl.innerHTML = html;
    if (prev && services[prev]) filterEl.value = prev; else filterEl.value = "";
  }

  /* ------------------------------------------------------------------ *
   * Filtering (search + service)
   * ------------------------------------------------------------------ */
  function applyFilters() {
    if (!cy) return;
    var query = (document.getElementById("search-input").value || "").trim().toLowerCase();
    var svcFilter = activeServiceFilter;
    var accEl = document.getElementById("account-filter");
    var regEl = document.getElementById("region-filter");
    var accFilter = accEl ? accEl.value : "";
    var regFilter = regEl ? regEl.value : "";
    var hasFilter = query.length > 0 || svcFilter.length > 0 || accFilter.length > 0 || regFilter.length > 0;

    if (!hasFilter && !state.focusArn) {
      cy.nodes().removeClass("highlighted dimmed");
      cy.edges().removeClass("highlighted dimmed");
      if (state.rootArn) {
        var rootNode = cy.getElementById(state.rootArn);
        if (rootNode.nonempty()) rootNode.addClass("root");
      }
      updateLegendDimming("");
      updateStatusBar();
      return;
    }

    var matchedNodes = cy.nodes().not(".group").filter(function (n) {
      var matchSvc = !svcFilter || n.data("service") === svcFilter;
      var matchAcc = !accFilter || n.data("accountId") === accFilter;
      var matchReg = !regFilter || n.data("region") === regFilter;
      var matchQuery = !query ||
        (n.data("rawLabel") || n.data("label") || "").toLowerCase().indexOf(query) !== -1 ||
        (n.data("arn") || "").toLowerCase().indexOf(query) !== -1 ||
        (n.data("type") || "").toLowerCase().indexOf(query) !== -1 ||
        (n.data("service") || "").toLowerCase().indexOf(query) !== -1;
      return matchSvc && matchAcc && matchReg && matchQuery;
    });

    cy.nodes().not(".group").removeClass("highlighted").addClass("dimmed");
    cy.edges().removeClass("highlighted").addClass("dimmed");

    matchedNodes.removeClass("dimmed").addClass("highlighted");
    matchedNodes.connectedEdges().removeClass("dimmed").addClass("highlighted");
    matchedNodes.connectedEdges().connectedNodes().removeClass("dimmed");

    updateLegendDimming(svcFilter);
    updateStatusBar();
  }

  function updateLegendDimming(activeSvc) {
    Array.prototype.forEach.call(document.querySelectorAll(".legend-item[data-service]"), function (item) {
      if (activeSvc && item.getAttribute("data-service") !== activeSvc) {
        item.classList.add("dimmed");
      } else {
        item.classList.remove("dimmed");
      }
    });
  }

  function updateCountsAndFilters() {
    buildServiceFilterOptions();
    buildAccountRegionFilterOptions();
    buildLegend();
    updateStatusBar();
  }

  /* ------------------------------------------------------------------ *
   * Status bar
   * ------------------------------------------------------------------ */
  function updateStatusBar() {
    if (!cy) return;
    var realNodes = cy.nodes().not(".group");
    var accounts = {};
    var regions = {};
    realNodes.forEach(function (n) {
      var a = n.data("accountId"); if (a) accounts[a] = true;
      var r = n.data("region");    if (r) regions[r]  = true;
    });
    var accList = Object.keys(accounts);
    var regList = Object.keys(regions);

    var scopeParts = [];
    if (accList.length === 1) {
      scopeParts.push("Account " + accList[0]);
    } else if (accList.length > 1) {
      scopeParts.push(accList.length + " accounts");
    }
    if (regList.length <= 3) {
      regList.forEach(function (r) { scopeParts.push(r); });
    } else {
      scopeParts.push(regList.length + " regions");
    }
    var scopeEl = document.getElementById("status-scope");
    if (scopeEl) {
      scopeEl.textContent = scopeParts.length > 0 ? scopeParts.join("  \u00B7  ") : "\u2014";
    }

    var filters = [];
    var query = (document.getElementById("search-input").value || "").trim();
    if (query) filters.push('q="' + query + '"');
    if (activeServiceFilter) filters.push("service=" + activeServiceFilter);
    var accF = document.getElementById("account-filter");
    var regF = document.getElementById("region-filter");
    if (accF && accF.value) filters.push("account=" + accF.value);
    if (regF && regF.value) filters.push("region=" + regF.value);
    if (state.focusArn) filters.push("focus on " + shortArn(state.focusArn));
    if (state.hiddenIds.size > 0) filters.push("hidden=" + state.hiddenIds.size);
    var filtersEl = document.getElementById("status-filters");
    if (filtersEl) {
      filtersEl.textContent = filters.length > 0 ? "Filters: " + filters.join(", ") : "";
    }

    var countsEl = document.getElementById("status-counts");
    if (countsEl) {
      countsEl.textContent = realNodes.length + " nodes \u00B7 " + cy.edges().length + " edges";
    }

    var refreshEl = document.getElementById("status-refresh");
    if (refreshEl) {
      if (state.lastRefreshTs > 0) {
        var d = new Date(state.lastRefreshTs);
        var hh = d.getHours();
        var mm = d.getMinutes();
        var ss = d.getSeconds();
        var timestr = pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
        refreshEl.textContent = "Updated " + timestr;
      } else {
        refreshEl.textContent = "Awaiting data\u2026";
      }
    }
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function shortArn(arn) {
    if (!arn) return "";
    return arn.length > 28 ? "\u2026" + arn.slice(-26) : arn;
  }

  /* ------------------------------------------------------------------ *
   * Details panel (right side)
   * ------------------------------------------------------------------ */
  function renderDetails(payload) {
    var detailsEmpty = document.getElementById("details-empty");
    var detailsDiv = document.getElementById("details");
    detailsEmpty.style.display = "none";
    detailsDiv.style.display = "block";

    var html = "<h2>" + escapeHtml(payload.title) + "</h2>";
    html += '<div class="subtitle">' + escapeHtml(payload.subtitle) + "</div>";

    html += '<div class="detail-section"><h3>Metadata</h3>';
    for (var i = 0; i < payload.metadata.length; i++) {
      html += '<div class="detail-row"><span class="label">' + escapeHtml(payload.metadata[i].label) + '</span><span class="value">' + escapeHtml(payload.metadata[i].value) + "</span></div>";
    }
    html += "</div>";

    if (payload.tags && payload.tags.length > 0) {
      html += '<div class="detail-section"><h3>Tags</h3>';
      for (var t = 0; t < payload.tags.length; t++) {
        html += '<div class="detail-row"><span class="label">' + escapeHtml(payload.tags[t].key) + '</span><span class="value">' + escapeHtml(payload.tags[t].value) + "</span></div>";
      }
      html += "</div>";
    }

    if (payload.actions && payload.actions.length > 0) {
      html += '<div class="detail-section"><h3>Actions</h3>';
      for (var a = 0; a < payload.actions.length; a++) {
        html += '<button class="action-button" data-action-id="' + escapeHtml(payload.actions[a].id) + '" data-arn="' + escapeHtml(payload.arn) + '">' + escapeHtml(payload.actions[a].title) + "</button>";
      }
      html += "</div>";
    }

    detailsDiv.innerHTML = html;

    var buttons = detailsDiv.querySelectorAll(".action-button");
    for (var b = 0; b < buttons.length; b++) {
      buttons[b].addEventListener("click", function () {
        vscode.postMessage({
          type: "runAction",
          arn: this.getAttribute("data-arn"),
          actionId: this.getAttribute("data-action-id")
        });
      });
    }
  }

  /* ------------------------------------------------------------------ *
   * Search results dropdown
   * ------------------------------------------------------------------ */
  function renderSearchResults(results) {
    var container = document.getElementById("search-results");
    if (!results || results.length === 0) {
      container.classList.remove("visible");
      container.innerHTML = "";
      return;
    }

    var graphNodeIds = new Set();
    if (cy) {
      cy.nodes().not(".group").forEach(function (n) { graphNodeIds.add(n.id()); });
    }

    var html = "";
    for (var i = 0; i < results.length; i++) {
      var svc = (results[i].subtitle || "").split(" \u2022 ")[0].toLowerCase().replace(/\s/g, "");
      var svcKey = Object.keys(SERVICE_LABELS).find(function (k) {
        return SERVICE_LABELS[k].toLowerCase().replace(/\s/g, "") === svc;
      }) || "";
      var dotColor = getColor(svcKey);
      var inGraph = graphNodeIds.has(results[i].arn);

      html += '<div class="search-result-item" data-arn="' + escapeHtml(results[i].arn) + '">';
      html += '<div class="svc-dot" style="background:' + dotColor + ';"></div>';
      html += '<div class="result-text">';
      html += '<div class="label">' + escapeHtml(results[i].label) + "</div>";
      html += '<div class="subtitle">' + escapeHtml(results[i].subtitle) + "</div>";
      html += '</div>';
      if (inGraph) html += '<span class="in-graph-badge">In Graph</span>';
      html += "</div>";
    }

    container.innerHTML = html;
    container.classList.add("visible");

    var items = container.querySelectorAll(".search-result-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function () {
        var arn = this.getAttribute("data-arn");
        container.classList.remove("visible");

        if (cy && cy.getElementById(arn).length) {
          cy.nodes().removeClass("highlighted dimmed");
          cy.edges().removeClass("highlighted dimmed");
          var node = cy.getElementById(arn);
          node.addClass("highlighted");
          cy.animate({ center: { eles: node }, zoom: 2 }, { duration: 400 });
          vscode.postMessage({ type: "requestDetails", arn: arn });
        } else {
          vscode.postMessage({ type: "openResource", arn: arn });
        }
      });
    }
  }

  function escapeHtml(text) {
    if (text === null || text === undefined) return "";
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(text)));
    return div.innerHTML;
  }

  /* ------------------------------------------------------------------ *
   * Message handling (from extension host)
   * ------------------------------------------------------------------ */
  window.addEventListener("message", function (event) {
    var message = event.data;
    switch (message.type) {
      case "replaceGraph":
        mergeIncomingPayload(message.payload, true);
        rebuildGraph();
        break;
      case "appendGraph":
        mergeIncomingPayload(message.payload, false);
        rebuildGraph();
        break;
      case "details":
        renderDetails(message.payload);
        break;
      case "searchResults":
        renderSearchResults(message.payload);
        break;
    }
  });

  /* ------------------------------------------------------------------ *
   * Toolbar control wiring
   * ------------------------------------------------------------------ */
  function wireControls() {
    var searchInput = document.getElementById("search-input");
    var searchDebounce = null;
    searchInput.addEventListener("input", function () {
      clearTimeout(searchDebounce);
      var query = searchInput.value.trim();
      applyFilters();
      searchDebounce = setTimeout(function () {
        if (query.length >= 2) {
          vscode.postMessage({ type: "search", query: query });
        } else {
          document.getElementById("search-results").classList.remove("visible");
        }
      }, 300);
    });

    searchInput.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        document.getElementById("search-results").classList.remove("visible");
        activeServiceFilter = "";
        document.getElementById("service-filter").value = "";
        var accEsc = document.getElementById("account-filter");
        var regEsc = document.getElementById("region-filter");
        if (accEsc) accEsc.value = "";
        if (regEsc) regEsc.value = "";
        applyFilters();
      }
    });

    document.addEventListener("click", function (e) {
      var results = document.getElementById("search-results");
      if (!results.contains(e.target) && e.target !== searchInput) {
        results.classList.remove("visible");
      }
      var menu = document.getElementById("context-menu");
      if (menu && menu.classList.contains("visible") && !menu.contains(e.target)) {
        hideContextMenu();
      }
    });

    document.addEventListener("keydown", function (e) {
      var isFindShortcut = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
      if (isFindShortcut) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      }
      if (e.key === "Escape") {
        hideContextMenu();
        if (state.focusArn) clearFocusNeighborhood();
      }
    });

    document.getElementById("service-filter").addEventListener("change", function () {
      activeServiceFilter = this.value;
      applyFilters();
    });

    var accountFilterEl = document.getElementById("account-filter");
    if (accountFilterEl) {
      accountFilterEl.addEventListener("change", function () {
        applyFilters();
      });
    }
    var regionFilterEl = document.getElementById("region-filter");
    if (regionFilterEl) {
      regionFilterEl.addEventListener("change", function () {
        applyFilters();
      });
    }

    document.getElementById("btn-fit").addEventListener("click", function () {
      if (cy) cy.fit(undefined, 50);
    });

    document.getElementById("btn-relayout").addEventListener("click", function () {
      runLayout();
    });

    document.getElementById("btn-reset").addEventListener("click", function () {
      var searchInput = document.getElementById("search-input");
      searchInput.value = "";
      document.getElementById("search-results").classList.remove("visible");
      activeServiceFilter = "";
      var sf = document.getElementById("service-filter");
      if (sf) sf.value = "";
      var accReset = document.getElementById("account-filter");
      var regReset = document.getElementById("region-filter");
      if (accReset) accReset.value = "";
      if (regReset) regReset.value = "";
      if (cy) {
        cy.nodes().removeClass("highlighted dimmed");
        cy.edges().removeClass("highlighted dimmed");
        updateLegendDimming("");
      }
      state.hiddenIds = new Set();
      state.focusArn = "";
      vscode.postMessage({ type: "resetGraph" });
    });

    document.getElementById("group-select").addEventListener("change", function () {
      state.groupMode = this.value || "none";
      rebuildGraph();
    });

    var focusBtn = document.getElementById("btn-focus");
    focusBtn.addEventListener("click", function () {
      state.focusModeEnabled = !state.focusModeEnabled;
      focusBtn.textContent = "Focus: " + (state.focusModeEnabled ? "on" : "off");
      focusBtn.classList.toggle("is-active", state.focusModeEnabled);
      if (!state.focusModeEnabled && state.focusArn) {
        clearFocusNeighborhood();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */
  function boot() {
    wireControls();
    initCytoscape();
  }

  if (document.readyState !== "loading") {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }
})();
