/* Capital 7 Syndicate 24 — app logic.
 * Pattern mirrors Build A Trust 24 (trust-app.js): Firebase compat SDK,
 * Google sign-in, profile doc with admin-only paidAccess, freemium gate
 * (browse free; the membership pop-up fires when the CRM core is opened;
 * checkout URLs unset -> honest placeholder, never a fake payment link).
 * Data (per signed-in user, see firestore-syndicate.rules):
 *   syndicateUsers/{uid}                      profile
 *   syndicateUsers/{uid}/raises/{raiseId}     raises + checklist + deck
 *   syndicateUsers/{uid}/raises/{id}/investors/{invId}
 *   syndicateUsers/{uid}/firms/{firmId}
 *   syndicateSignups/{id}                     free sign-up capture
 */
(function () {
  "use strict";

  var BANNER = "TEMPLATE — EDUCATIONAL ONLY. This is not legal advice and is not a finished legal document. Have a securities attorney review and finalize before any use with investors.";
  var VOID_LINE = "Void where prohibited by law.";
  var PRIVACY_LINE = "Anyone who receives this can view the full document — share it only with people you intend to see it.";
  var CHECKOUT_SOON = "Checkout opens at launch — sign up free now and we'll email your access link.";
  var STEPS = ["", "Step 1 — Structure the company", "Step 2 — Private placement memorandum",
    "Step 3 — Pitch deck", "Step 4 — Transfer agent", "Step 5 — Boutique firms raising", "Closed"];
  var CHECKS = [
    ["structure", "Company structure in place"],
    ["memorandum", "Private placement memorandum"],
    ["deck", "Pitch deck"],
    ["transferAgent", "Transfer agent engaged"],
    ["docsOut", "Investor documents out"],
    ["docsSigned", "Investor documents signed"]
  ];

  var state = {
    user: null, paidAccess: false, db: null, auth: null,
    raises: [], firms: [], currentRaiseId: null,
    investors: [], files: [], deckSlides: [], deckIdx: 0, lastDocHtml: "", lastDocName: ""
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    n = Number(n) || 0;
    return "$" + n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  function num(id) { var el = $(id); var v = el ? parseFloat(el.value) : 0; return isNaN(v) ? 0 : v; }
  function val(id) { var el = $(id); return el ? String(el.value || "").trim() : ""; }
  function setMsg(id, text, ok) {
    var el = $(id); if (!el) return;
    el.textContent = text || "";
    el.className = "msg" + (text ? (ok ? " ok" : " bad") : "");
  }
  function isAdmin(user) {
    if (!user || !user.email) return false;
    var list = window.SYNDICATE_ADMIN_EMAILS || [];
    return list.indexOf(user.email) >= 0;
  }
  function entitled() { return isAdmin(state.user) || state.paidAccess === true; }

  /* ---------------- calculator (free, no auth) ---------------- */
  function runCalc() {
    var target = num("calcTarget"), feePct = num("calcFee"), avg = num("calcAvg");
    var fee = target * feePct / 100, net = target - fee;
    var investors = avg > 0 ? Math.ceil(target / avg) : 0;
    var out = $("calcOut"); if (!out) return;
    out.innerHTML =
      "<p><strong>Raise target:</strong> " + money(target) + "<br>" +
      "<strong>Boutique firm fee at " + esc(feePct) + "%:</strong> " + money(fee) + "<br>" +
      "<strong>You keep (before other costs):</strong> " + money(net) + "<br>" +
      "<strong>Investors needed at a " + money(avg) + " average check:</strong> " +
      (investors ? String(investors) : "— set an average check") + "</p>" +
      "<p class='msg'>Scenario math only, on the roadmap's ~1% model — not a quote or a guarantee.</p>";
  }

  /* ---------------- gate ---------------- */
  function openGate() { var m = $("gateModal"); if (m) m.hidden = false; }
  function closeGate() { var m = $("gateModal"); if (m) m.hidden = true; }
  function planAction() {
    var cfg = window.SYNDICATE_PLANS || {};
    var url = cfg.checkoutMonthlyUrl || cfg.checkoutUrl || "";
    if (url) { window.open(url, "_blank", "noopener"); return; }
    setMsg("planMsg", CHECKOUT_SOON, true);
    setMsg("gateMsg", CHECKOUT_SOON, true);
    var s = $("signup"); if (s && s.scrollIntoView) s.scrollIntoView({ behavior: "smooth" });
  }
  function openCRM() {
    if (!state.user) {
      setMsg("crmLockMsg", "Sign in with Google first — the CRM lives in your account.", false);
      setMsg("gateNotice", "Sign in with Google to open the CRM.", false);
      var s = $("signup"); if (s && s.scrollIntoView) s.scrollIntoView({ behavior: "smooth" });
      return;
    }
    if (!entitled()) { openGate(); return; }
    showCRM();
  }
  function showCRM() {
    var locked = $("crmLocked"), app = $("crmApp");
    if (locked) locked.classList.add("hidden");
    if (app) app.classList.remove("hidden");
    var s = $("crm"); if (s && s.scrollIntoView) s.scrollIntoView({ behavior: "smooth" });
    loadAll();
  }

  /* ---------------- auth ---------------- */
  function signIn() {
    if (!state.auth) { setMsg("signupMsg", "Sign-in is still loading — try again in a moment.", false); return; }
    var provider = new firebase.auth.GoogleAuthProvider();
    state.auth.signInWithPopup(provider).catch(function (err) {
      if (err && err.code === "auth/popup-blocked") {
        state.auth.signInWithRedirect(provider).catch(function () {});
        return;
      }
      if (err && err.code === "auth/popup-closed-by-user") {
        setMsg("signupMsg", "Sign-in window closed — nothing was changed.", false);
        return;
      }
      setMsg("signupMsg", "Sign-in failed. Please try again.", false);
    });
  }
  function signOut() { if (state.auth) state.auth.signOut(); }

  function upsertProfile(user) {
    var ref = state.db.collection("syndicateUsers").doc(user.uid);
    return ref.get().then(function (snap) {
      var base = {
        name: user.displayName || "", email: user.email || "",
        photo: user.photoURL || ""
      };
      if (!snap.exists) {
        base.paidAccess = false;
        base.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        return ref.set(base).then(function () {
          state.paidAccess = false;
          return state.db.collection("syndicateSignups").add({
            name: base.name, email: base.email, uid: user.uid, source: "syndicate-crm",
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          }).catch(function () {});
        });
      }
      state.paidAccess = snap.data().paidAccess === true;
      return ref.update(base).catch(function () { return ref.set(base, { merge: true }); });
    }).catch(function () {});
  }

  function onAuth(user) {
    state.user = user || null;
    var who = $("authWho"), inBtn = $("signInBtn"), outBtn = $("signOutBtn");
    if (who) who.textContent = user ? ("Signed in: " + (user.email || "")) : "";
    if (inBtn) inBtn.classList.toggle("hidden", !!user);
    if (outBtn) outBtn.classList.toggle("hidden", !user);
    if (!user) {
      state.paidAccess = false;
      var app = $("crmApp"), locked = $("crmLocked");
      if (app) app.classList.add("hidden");
      if (locked) locked.classList.remove("hidden");
      return;
    }
    upsertProfile(user).then(function () {
      setMsg("signupMsg", entitled() ? "Signed in — membership active. Open the CRM any time." :
        "Signed in free. The CRM opens with membership ($20/mo).", true);
    });
  }

  /* ---------------- data ---------------- */
  function userCol(name) { return state.db.collection("syndicateUsers").doc(state.user.uid).collection(name); }
  function raiseRef(id) { return userCol("raises").doc(id); }
  function currentRaise() {
    for (var i = 0; i < state.raises.length; i++) if (state.raises[i].id === state.currentRaiseId) return state.raises[i];
    return null;
  }

  function loadAll() {
    if (!state.user || !state.db) return;
    userCol("raises").orderBy("createdAt", "asc").get().then(function (snap) {
      state.raises = [];
      snap.forEach(function (d) { var r = d.data(); r.id = d.id; state.raises.push(r); });
      renderRaises();
      return loadDashboard();
    }).catch(function () { setMsg("dashMsg", "Could not load your raises.", false); });
    userCol("firms").orderBy("createdAt", "asc").get().then(function (snap) {
      state.firms = [];
      snap.forEach(function (d) { var f = d.data(); f.id = d.id; state.firms.push(f); });
      renderFirms();
    }).catch(function () {});
  }

  function loadDashboard() {
    var totals = { target: 0, committed: 0, collected: 0 };
    var chain = Promise.resolve();
    state.raises.forEach(function (r) {
      totals.target += Number(r.target) || 0;
      chain = chain.then(function () {
        return raiseRef(r.id).collection("investors").get().then(function (snap) {
          snap.forEach(function (d) {
            var inv = d.data();
            totals.committed += Number(inv.committed) || 0;
            totals.collected += Number(inv.collected) || 0;
          });
        }).catch(function () {});
      });
    });
    return chain.then(function () {
      if ($("dashTarget")) $("dashTarget").textContent = money(totals.target);
      if ($("dashCommitted")) $("dashCommitted").textContent = money(totals.committed);
      if ($("dashCollected")) $("dashCollected").textContent = money(totals.collected);
      if ($("dashFee")) $("dashFee").textContent = money(totals.committed * 0.01);
      var pct = totals.target > 0 ? Math.min(100, Math.round(totals.committed / totals.target * 100)) : 0;
      if ($("dashBar")) $("dashBar").style.width = pct + "%";
    });
  }

  /* ---------------- raises ---------------- */
  function renderRaises() {
    var box = $("raiseList"); if (!box) return;
    box.innerHTML = "";
    if (!state.raises.length) {
      box.innerHTML = "<p class='msg'>No raises yet — create your first one above.</p>";
      return;
    }
    var table = document.createElement("table");
    var html = "<tr><th>Raise</th><th>Company</th><th>Target</th><th>Pipeline step</th><th></th></tr>";
    state.raises.forEach(function (r) {
      html += "<tr><td>" + esc(r.name) + "</td><td>" + esc(r.company) + "</td><td>" + money(r.target) +
        "</td><td>" + esc(STEPS[Number(r.status) || 1] || "") + "</td>" +
        "<td><button type='button' class='btn small' data-open-raise='" + esc(r.id) + "'>Open</button> " +
        "<button type='button' class='btn small ghost' data-del-raise='" + esc(r.id) + "'>Delete</button></td></tr>";
    });
    table.innerHTML = html;
    box.appendChild(table);
    var opens = table.querySelectorAll("[data-open-raise]");
    for (var i = 0; i < opens.length; i++) (function (btn) {
      btn.addEventListener("click", function () { selectRaise(btn.getAttribute("data-open-raise")); });
    })(opens[i]);
    var dels = table.querySelectorAll("[data-del-raise]");
    for (var j = 0; j < dels.length; j++) (function (btn) {
      btn.addEventListener("click", function () { deleteRaise(btn.getAttribute("data-del-raise")); });
    })(dels[j]);
  }

  function addRaise(ev) {
    ev.preventDefault();
    if (!state.user) return;
    var data = {
      name: val("raiseName"), company: val("raiseCompany"),
      target: num("raiseTarget"), status: Number(val("raiseStatus")) || 1,
      checklist: { structure: false, memorandum: false, deck: false, transferAgent: false, docsOut: false, docsSigned: false },
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    userCol("raises").add(data).then(function (ref) {
      state.currentRaiseId = ref.id;
      loadAll();
    }).catch(function () { setMsg("dashMsg", "Could not save the raise.", false); });
  }

  function deleteRaise(id) {
    raiseRef(id).delete().then(function () {
      if (state.currentRaiseId === id) { state.currentRaiseId = null; hideDetail(); }
      loadAll();
    }).catch(function () {});
  }

  function selectRaise(id) {
    state.currentRaiseId = id;
    var r = currentRaise();
    var detail = $("raiseDetail");
    if (!r || !detail) return;
    detail.classList.remove("hidden");
    if ($("detailTitle")) $("detailTitle").textContent = "Raise: " + (r.name || "") + " — " + (r.company || "");
    prefillGenerators(r);
    renderChecklist(r);
    loadInvestors();
    prefillProperty(r);
    loadFiles();
    if (detail.scrollIntoView) detail.scrollIntoView({ behavior: "smooth" });
  }
  function hideDetail() {
    var d = $("raiseDetail"); if (d) d.classList.add("hidden");
  }

  /* ---------------- checklist + generator wiring ---------------- */
  function renderChecklist(r) {
    var box = $("checklist"); if (!box || !r) return;
    box.innerHTML = "";
    var checks = r.checklist || {};
    CHECKS.forEach(function (pair) {
      var key = pair[0], label = pair[1];
      var row = document.createElement("div");
      row.className = "checkitem";
      var cb = document.createElement("input");
      cb.type = "checkbox"; cb.checked = checks[key] === true;
      cb.setAttribute("data-check", key);
      cb.addEventListener("change", function () { toggleCheck(key, cb.checked); });
      var span = document.createElement("span");
      span.textContent = label;
      row.appendChild(cb); row.appendChild(span);
      if (key === "memorandum" || key === "deck") {
        var gen = document.createElement("button");
        gen.type = "button"; gen.className = "btn small ghost";
        gen.textContent = "Generate →";
        gen.addEventListener("click", function () { toggleGenerator(key); });
        row.appendChild(gen);
      }
      box.appendChild(row);
    });
  }
  function toggleCheck(key, value) {
    var r = currentRaise(); if (!r) return;
    var patch = {}; var checks = {}; 
    CHECKS.forEach(function (p) { checks[p[0]] = (r.checklist || {})[p[0]] === true; });
    checks[key] = value; patch.checklist = checks;
    raiseRef(r.id).update(patch).then(function () {
      r.checklist = checks; renderChecklist(r);
    }).catch(function () { setMsg("detailMsg", "Could not save the checklist.", false); });
  }
  function markCheck(key) {
    var r = currentRaise(); if (!r) return;
    if ((r.checklist || {})[key] === true) return;
    toggleCheck(key, true);
  }
  function toggleGenerator(which) {
    var deck = $("deckGen"), doc = $("docGen");
    if (which === "deck") { if (deck) deck.classList.toggle("hidden"); if (doc) doc.classList.add("hidden"); }
    else { if (doc) doc.classList.toggle("hidden"); if (deck) deck.classList.add("hidden"); }
  }
  function prefillGenerators(r) {
    if ($("docIssuer") && !$("docIssuer").value) $("docIssuer").value = r.company || "";
    if ($("deckAsk") && !$("deckAsk").value) $("deckAsk").value = "Raising " + money(r.target) + " for " + (r.company || "the company") + ".";
    var d = r.deck || {};
    if ($("deckTagline") && d.tagline) $("deckTagline").value = d.tagline;
    if ($("deckProblem") && d.problem) $("deckProblem").value = d.problem;
    if ($("deckSolution") && d.solution) $("deckSolution").value = d.solution;
    if ($("deckMarket") && d.market) $("deckMarket").value = d.market;
    if ($("deckUse") && d.use) $("deckUse").value = d.use;
    if ($("deckTerms") && d.terms) $("deckTerms").value = d.terms;
    if ($("deckTeam") && d.team) $("deckTeam").value = d.team;
    if ($("deckContact") && d.contact) $("deckContact").value = d.contact;
  }

  /* ---------------- investors ---------------- */
  function loadInvestors() {
    var r = currentRaise(); if (!r) return;
    raiseRef(r.id).collection("investors").orderBy("createdAt", "asc").get().then(function (snap) {
      state.investors = [];
      snap.forEach(function (d) { var inv = d.data(); inv.id = d.id; state.investors.push(inv); });
      renderInvestors();
    }).catch(function () {});
  }
  function renderInvestors() {
    var box = $("investorList"); if (!box) return;
    box.innerHTML = "";
    if (!state.investors.length) { box.innerHTML = "<p class='msg'>No investors on this raise yet.</p>"; return; }
    var table = document.createElement("table");
    var html = "<tr><th>Investor</th><th>Committed</th><th>Collected</th><th>Documents</th><th></th></tr>";
    state.investors.forEach(function (inv) {
      html += "<tr><td>" + esc(inv.name) + "<br><span class='msg'>" + esc(inv.email || "") + "</span></td><td>" +
        money(inv.committed) + "</td><td>" + money(inv.collected) + "</td><td>" + esc(inv.docStatus || "") +
        "</td><td><button type='button' class='btn small ghost' data-del-inv='" + esc(inv.id) + "'>Remove</button></td></tr>";
    });
    table.innerHTML = html;
    box.appendChild(table);
    var dels = table.querySelectorAll("[data-del-inv]");
    for (var i = 0; i < dels.length; i++) (function (btn) {
      btn.addEventListener("click", function () {
        var r = currentRaise(); if (!r) return;
        raiseRef(r.id).collection("investors").doc(btn.getAttribute("data-del-inv")).delete()
          .then(function () { loadInvestors(); loadDashboard(); }).catch(function () {});
      });
    })(dels[i]);
    // Per-investor document attach (files live in state.files, tagged investorId).
    state.investors.forEach(function (inv) {
      var wrap = document.createElement("div");
      wrap.className = "checkitem";
      var span = document.createElement("span");
      span.textContent = "Documents for " + (inv.name || "investor") + " — attach:";
      wrap.appendChild(span);
      var input = document.createElement("input");
      input.type = "file";
      input.setAttribute("data-inv-file", inv.id);
      input.setAttribute("accept", ".pdf,.doc,.docx,.xls,.xlsx,.txt,image/jpeg,image/png,image/webp");
      input.addEventListener("change", function () { uploadInvestorFile(inv.id, input); });
      wrap.appendChild(input);
      state.files.filter(function (f) { return f.investorId === inv.id; }).forEach(function (rec) {
        var a = viewLink(rec); a.textContent = rec.name; wrap.appendChild(a);
      });
      box.appendChild(wrap);
    });
  }
  function addInvestor(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r) return;
    raiseRef(r.id).collection("investors").add({
      name: val("invName"), email: val("invEmail"),
      committed: num("invCommitted"), collected: num("invCollected"),
      docStatus: val("invDoc"),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(function () { loadInvestors(); loadDashboard(); })
      .catch(function () { setMsg("detailMsg", "Could not save the investor.", false); });
  }

  /* ---------------- firms ---------------- */
  function renderFirms() {
    var box = $("firmList"); if (!box) return;
    box.innerHTML = "";
    if (!state.firms.length) { box.innerHTML = "<p class='msg'>No firms yet — add the boutique firms you are talking to.</p>"; return; }
    var table = document.createElement("table");
    var html = "<tr><th>Firm</th><th>Contact</th><th>Fee</th><th></th></tr>";
    state.firms.forEach(function (f) {
      html += "<tr><td>" + esc(f.name) + "</td><td>" + esc(f.contact || "") + "</td><td>" +
        esc(f.feePct) + "%</td><td><button type='button' class='btn small ghost' data-del-firm='" +
        esc(f.id) + "'>Remove</button></td></tr>";
    });
    table.innerHTML = html;
    box.appendChild(table);
    var dels = table.querySelectorAll("[data-del-firm]");
    for (var i = 0; i < dels.length; i++) (function (btn) {
      btn.addEventListener("click", function () {
        userCol("firms").doc(btn.getAttribute("data-del-firm")).delete().then(loadAll).catch(function () {});
      });
    })(dels[i]);
  }
  function addFirm(ev) {
    ev.preventDefault();
    if (!state.user) return;
    userCol("firms").add({
      name: val("firmName"), contact: val("firmContact"), feePct: num("firmFee"),
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(loadAll).catch(function () {});
  }

  /* ---------------- deck generator ---------------- */
  function buildDeck(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r) return;
    var d = {
      tagline: val("deckTagline"), problem: val("deckProblem"), solution: val("deckSolution"),
      market: val("deckMarket"), use: val("deckUse"), terms: val("deckTerms"),
      team: val("deckTeam"), ask: val("deckAsk"), contact: val("deckContact")
    };
    state.deckSlides = [
      { k: r.name || "The Raise", t: r.company || "", p: d.tagline || "" },
      { k: "The Problem", t: "The Problem", p: d.problem },
      { k: "The Solution", t: "The Solution", p: d.solution },
      { k: "The Opportunity", t: "The Opportunity / Market", p: d.market },
      { k: "Use of Funds", t: "What the Money Does", p: d.use },
      { k: "The Terms", t: "Raise Terms — Summary", p: d.terms },
      { k: "The Team", t: "The Team", p: d.team },
      { k: "The Ask", t: "The Ask", p: d.ask || ("Raising " + money(r.target) + ".") },
      { k: "Contact", t: "Next Steps", p: (d.contact || "") + "\n\nStructured on the 5-step roadmap: company structure, private placement memorandum, pitch deck, transfer agent, boutique firms." }
    ];
    var propSlides = propertySlides(r);
    if (propSlides.length) {
      state.deckSlides = [state.deckSlides[0]].concat(propSlides, state.deckSlides.slice(1));
    }
    state.deckIdx = 0;
    renderDeckSlide();
    renderDeckPrint();
    raiseRef(r.id).update({ deck: d }).then(function () { markCheck("deck"); }).catch(function () { markCheck("deck"); });
    setMsg("detailMsg", "Deck built — page through it, download it, or share the exported copy.", true);
  }
  function slideHtml(s) {
    var h = "<div class='slide'><div class='kicker'>" + esc(s.k) + "</div><h3>" + esc(s.t) + "</h3>";
    if (s.img) h += "<img src='" + esc(s.img) + "' alt='' style='width:100%;border-radius:8px;margin:0 0 12px'>";
    h += "<p>" + esc(s.p) + "</p>";
    if (s.strip && s.strip.length) {
      h += "<div style='display:flex;gap:8px;flex-wrap:wrap'>";
      s.strip.forEach(function (u) { h += "<img src='" + esc(u) + "' alt='' style='width:31%;border-radius:6px'>"; });
      h += "</div>";
    }
    return h + "</div>";
  }
  /* Property Profile slides for the deck: hero photo + facts first, then a
   * photo strip when there is more than one photo. Empty when the raise has
   * neither photos nor facts — the deck then builds exactly as before. */
  function propertySlides(r) {
    var photos = state.files.filter(function (f) { return f.kind === "photo"; });
    var p = (r && r.property) || {};
    var facts = [];
    if (p.type) facts.push("Property type: " + p.type);
    if (Number(p.beds)) facts.push("Bedrooms: " + p.beds);
    if (Number(p.baths)) facts.push("Bathrooms: " + p.baths);
    if (Number(p.sqft)) facts.push("Square feet: " + Number(p.sqft).toLocaleString("en-US"));
    if (Number(p.price)) facts.push("Purchase price: " + money(p.price));
    if (Number(p.rehab)) facts.push("Rehab estimate: " + money(p.rehab));
    if (Number(p.arv)) facts.push("After-repair value (ARV): " + money(p.arv));
    if (!photos.length && !facts.length && !p.address) return [];
    var hero = null;
    photos.forEach(function (f) { if (f.hero && !hero) hero = f; });
    if (!hero && photos.length) hero = photos[0];
    var slides = [{
      k: "Property Profile", t: p.address || "The Property",
      p: facts.join("\n") || "Property facts on file in the raise workspace.",
      img: hero ? hero.url : ""
    }];
    if (photos.length > 1) {
      slides.push({
        k: "Property Photos", t: "Property Photos",
        p: photos.length + " photos — the full set lives in this raise's file.",
        strip: photos.map(function (f) { return f.url; })
      });
    }
    return slides;
  }
  function renderDeckSlide() {
    var out = $("deckOut"); if (!out || !state.deckSlides.length) return;
    var pager = document.createElement("div");
    pager.innerHTML = slideHtml(state.deckSlides[state.deckIdx]) +
      "<p class='msg'>Slide " + (state.deckIdx + 1) + " of " + state.deckSlides.length + "</p>";
    out.innerHTML = "";
    out.appendChild(pager);
    var nav = $("deckNav"); if (!nav) return;
    nav.innerHTML = "";
    var prev = document.createElement("button");
    prev.type = "button"; prev.className = "btn small ghost"; prev.textContent = "← Prev slide";
    prev.disabled = state.deckIdx === 0;
    prev.addEventListener("click", function () { if (state.deckIdx > 0) { state.deckIdx--; renderDeckSlide(); } });
    var next = document.createElement("button");
    next.type = "button"; next.className = "btn small ghost"; next.textContent = "Next slide →";
    next.disabled = state.deckIdx >= state.deckSlides.length - 1;
    next.addEventListener("click", function () { if (state.deckIdx < state.deckSlides.length - 1) { state.deckIdx++; renderDeckSlide(); } });
    nav.appendChild(prev); nav.appendChild(next);
    showResultActions("deckOut", "deck");
  }
  function deckStandaloneHtml() {
    var r = currentRaise();
    var slides = state.deckSlides.map(slideHtml).join("\n");
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + esc(r ? r.company : "Pitch Deck") +
      " — Pitch Deck</title><style>body{background:#0a0a0c;color:#f2ead2;font-family:Georgia,serif}" +
      ".slide{border:2px solid #d4af37;border-radius:10px;padding:34px 30px;max-width:820px;margin:0 auto 14px;page-break-after:always}" +
      ".slide .kicker{color:#d4af37;letter-spacing:.22em;text-transform:uppercase;font-size:12px}" +
      ".slide h3{font-size:30px}.slide p{font-size:18px;white-space:pre-wrap}.slide img{max-width:100%}</style></head><body>" +
      slides + "</body></html>";
  }
  function renderDeckPrint() {
    var root = $("deckPrintRoot"); if (!root) return;
    root.innerHTML = state.deckSlides.map(slideHtml).join("\n");
  }
  function printDeck() {
    if (!state.deckSlides.length) { setMsg("detailMsg", "Build the deck first, then print it.", false); return; }
    renderDeckPrint();
    printArea("printing-deck");
  }

  /* ---------------- document generator ---------------- */
  function bannerHtml() { return "<div class='banner'>" + esc(BANNER) + "<br>" + esc(VOID_LINE) + "</div>"; }
  function docShell(title, bodyHtml) {
    return "<!DOCTYPE html><html><head><meta charset='utf-8'><title>" + esc(title) +
      "</title><style>body{background:#fff;color:#111;font-family:Georgia,serif;line-height:1.55}" +
      ".docpage{max-width:820px;margin:0 auto;padding:26px}.banner{border:3px solid #b00020;color:#b00020;" +
      "padding:12px 14px;font-weight:bold;text-transform:uppercase;margin-bottom:16px;font-size:14px}" +
      ".sigline{border-top:1px solid #111;margin-top:34px;padding-top:4px;font-size:13px;color:#444}" +
      "p,li{white-space:pre-wrap}</style></head><body><div class='docpage'>" +
      "<div class='banner'>" + esc(BANNER) + "<br>" + esc(VOID_LINE) + "</div>" + bodyHtml +
      "<div class='banner' style='margin-top:20px'>" + esc(BANNER) + "<br>" + esc(VOID_LINE) + "</div>" +
      "</div></body></html>";
  }
  function showDoc(html, name) {
    state.lastDocHtml = docShell(name, html); state.lastDocName = name;
    var out = $("docOut"); if (!out) return;
    out.innerHTML = "";
    var wrap = document.createElement("div");
    wrap.className = "docpage";
    wrap.innerHTML = bannerHtml() + html + bannerHtml();
    out.appendChild(wrap);
    showResultActions("docOut", "doc");
    var root = $("docPrintRoot");
    if (root) { root.innerHTML = ""; var p = document.createElement("div"); p.className = "docpage"; p.innerHTML = bannerHtml() + html + bannerHtml(); root.appendChild(p); }
  }
  function buildMemorandum(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r) return;
    var issuer = val("docIssuer") || r.company || "";
    var offering = val("docOffering") || "interests in the company";
    var use = val("docUse") || val("deckUse");
    var risks = val("docRisks");
    var today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    var body =
      "<h2 style='text-align:center'>PRIVATE PLACEMENT MEMORANDUM</h2>" +
      "<p style='text-align:center'><strong>" + esc(issuer) + "</strong><br>" + esc(r.name || "") + "<br>" +
      "Offering target: " + money(r.target) + "<br>Dated: " + esc(today) + "</p>" +
      "<h3>1. Summary of the Offering</h3><p>Issuer: " + esc(issuer) +
      (val("docState") ? ", organized in " + esc(val("docState")) : "") +
      ". This memorandum describes a proposed offering of " + esc(offering) +
      " with a target raise of " + money(r.target) +
      (num("docMin") > 0 ? " and a minimum investment of " + money(num("docMin")) + " per investor" : "") +
      ", as summarized by the issuer below. Terms are as stated by the issuer and are subject to final documentation.</p>" +
      "<h3>2. The Company</h3><p>" + esc(val("deckSolution") || "Company description to be completed by the issuer.") + "</p>" +
      "<h3>3. Use of Funds</h3><p>" + esc(use || "Use of funds to be completed by the issuer.") + "</p>" +
      "<h3>4. The Roadmap</h3><p>This raise is being organized on the 5-step roadmap: (1) structure the company, " +
      "(2) this private placement memorandum, (3) the pitch deck, (4) a transfer agent to handle investor documentation, " +
      "and (5) boutique investment firms engaged to raise the capital.</p>" +
      "<h3>5. Investor Information</h3><p>Investor documentation is administered with the assistance of a transfer agent" +
      (val("docAgent") ? " (" + esc(val("docAgent")) + ")" : "") +
      ". Investors receive the memorandum and supporting documents, return the intake information requested, " +
      "and sign the final documents prepared or approved by the issuer's securities attorney before any funds are accepted.</p>" +
      "<h3>6. Risk Notes (issuer's words)</h3><p>" + esc(risks || "Risk disclosure to be completed with the issuer's securities attorney. An investment involves risk, including possible loss of principal.") + "</p>" +
      "<h3>7. Signatures</h3>" +
      "<div class='sigline'>Issuer / Company — signature, printed name, title, date</div>" +
      "<div class='sigline'>Investor — signature, printed name, date</div>" +
      "<div class='sigline'>Investor — printed name of entity (if any), address, email</div>";
    showDoc(body, (issuer || "memorandum") + " — Private Placement Memorandum (Template)");
    markCheck("memorandum");
    setMsg("detailMsg", "Memorandum template generated — download it or share the exported copy. Attorney review required before any use.", true);
  }
  function buildIntake() {
    var r = currentRaise(); if (!r) return;
    var fields = ["Full legal name", "Entity name (if investing as an entity)", "Address", "Email", "Phone",
      "Amount committed ($)", "Amount enclosed / to be wired ($)", "How did you learn of this offering?",
      "Referred by (firm / person)", "Investor signature + date"];
    var rows = fields.map(function (f) {
      return "<p><strong>" + esc(f) + ":</strong> ______________________________________________</p>";
    }).join("");
    var body = "<h2 style='text-align:center'>INVESTOR INTAKE FORM</h2>" +
      "<p style='text-align:center'><strong>" + esc(r.company || "") + "</strong> — " + esc(r.name || "") +
      " · Raise target: " + money(r.target) + "</p>" + rows +
      "<p>Return the completed form to the issuer. Final investor documentation is prepared or approved by the issuer's securities attorney; the transfer agent administers the paperwork, the money movement, and the records.</p>";
    showDoc(body, (r.company || "raise") + " — Investor Intake Form (Template)");
    setMsg("detailMsg", "Intake form generated.", true);
  }
  function buildAgentLetter() {
    var r = currentRaise(); if (!r) return;
    var agent = val("docAgent") || "[Transfer Agent Name]";
    var checks = ["Engage the transfer agent in writing before documents go to investors.",
      "Confirm the agent will receive, track, and store investor documents.",
      "Confirm how investor funds move (who holds money, when it releases to the issuer).",
      "Confirm the investor register / cap-table records the agent will maintain.",
      "Confirm fees, timeline, and who the agent reports to.",
      "Confirm document status reporting back into this CRM (sent / signed)."];
    var items = checks.map(function (c) { return "<p>☐ " + esc(c) + "</p>"; }).join("");
    var body = "<h2 style='text-align:center'>TRANSFER-AGENT ENGAGEMENT — CHECKLIST &amp; LETTER</h2>" +
      "<p>To: " + esc(agent) + "</p>" +
      "<p>Re: Investor documentation administration for <strong>" + esc(r.company || "") + "</strong> — " + esc(r.name || "") +
      " (target raise " + money(r.target) + ").</p>" +
      "<p>We are organizing a private placement on a 5-step roadmap and are engaging a transfer agent to handle " +
      "investor documentation properly — moving the information, the money, and the paper between the company and its " +
      "investors, and keeping the records straight. Please confirm the items below.</p>" + items +
      "<div class='sigline'>Issuer — signature, printed name, title, date</div>" +
      "<div class='sigline'>Transfer agent — signature, printed name, date</div>";
    showDoc(body, (r.company || "raise") + " — Transfer-Agent Checklist & Letter (Template)");
    markCheck("transferAgent");
    setMsg("detailMsg", "Transfer-agent checklist generated.", true);
  }
  function printDoc() {
    if (!state.lastDocHtml) { setMsg("detailMsg", "Generate a document first, then print it.", false); return; }
    printArea("printing-doc");
  }
  function printArea(cls) {
    document.body.classList.remove("printing-deck");
    document.body.classList.remove("printing-doc");
    document.body.classList.add(cls);
    if (window.print) window.print();
    document.body.classList.remove(cls);
  }

  /* -------- download + share for generated output -------- */
  function downloadStandalone(html, filename) {
    try {
      var blob = new Blob([html], { type: "text/html" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 800);
    } catch (e) {
      setMsg("detailMsg", "Download isn't available here — use Print / save as PDF instead.", false);
    }
  }
  function shareText(title) { return title + " — built with Capital 7 Syndicate 24"; }
  function shareOutput(kind) {
    var isDeck = kind === "deck";
    var html = isDeck ? deckStandaloneHtml() : state.lastDocHtml;
    var title = isDeck ? "Pitch Deck" : (state.lastDocName || "Document");
    var fname = (isDeck ? "pitch-deck" : "document") + ".html";
    var nav = window.navigator || {};
    function fallbackMenu() {
      var url = window.location ? window.location.href : "";
      var enc = encodeURIComponent;
      var links = [
        ["Facebook", "https://www.facebook.com/sharer/sharer.php?u=" + enc(url)],
        ["X", "https://twitter.com/intent/tweet?url=" + enc(url) + "&text=" + enc(shareText(title))],
        ["WhatsApp", "https://wa.me/?text=" + enc(shareText(title) + " - " + url)],
        ["Telegram", "https://t.me/share/url?url=" + enc(url) + "&text=" + enc(shareText(title))]
      ];
      var out = $(isDeck ? "deckOut" : "docOut"); if (!out) return;
      var menu = document.createElement("div");
      menu.className = "card";
      var h = "<p><strong>Share:</strong> ";
      links.forEach(function (l) { h += "<a href='" + l[1] + "' target='_blank' rel='noopener'>" + l[0] + "</a> · "; });
      h += "</p><p class='msg'>" + esc(PRIVACY_LINE) + " For the full file itself, use Download and send the exported copy.</p>";
      menu.innerHTML = h;
      out.appendChild(menu);
    }
    try {
      if (nav.canShare && nav.share) {
        var file = new File([html], fname, { type: "text/html" });
        if (nav.canShare({ files: [file] })) {
          nav.share({ files: [file], title: title }).catch(function () {});
          return;
        }
      }
      if (nav.share) {
        var p = nav.share({ title: title, text: shareText(title), url: window.location ? window.location.href : "" });
        if (p && p.catch) p.catch(function () {});
        return;
      }
    } catch (e) { /* fall through to the menu */ }
    fallbackMenu();
  }
  function showResultActions(outId, kind) {
    var out = $(outId); if (!out) return;
    var row = document.createElement("div");
    row.className = "rowflex"; row.style.marginTop = "10px";
    var dl = document.createElement("button");
    dl.type = "button"; dl.className = "btn small"; dl.textContent = "Download";
    dl.addEventListener("click", function () {
      if (kind === "deck") downloadStandalone(deckStandaloneHtml(), "pitch-deck.html");
      else downloadStandalone(state.lastDocHtml, "document.html");
    });
    var sh = document.createElement("button");
    sh.type = "button"; sh.className = "btn small ghost"; sh.textContent = "Share";
    sh.addEventListener("click", function () { shareOutput(kind); });
    var note = document.createElement("p");
    note.className = "msg"; note.textContent = PRIVACY_LINE;
    row.appendChild(dl); row.appendChild(sh);
    out.appendChild(row); out.appendChild(note);
  }

  /* ---------------- property profile + file uploads ----------------
   * Files live in Firebase Storage under a syndicate-namespaced, per-user
   * path (see storage-syndicate.rules); metadata lives in the raise's
   * `files` subcollection (see firestore-syndicate.rules). */
  var PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
  var PHOTO_MAX = 10 * 1024 * 1024, DOC_MAX = 25 * 1024 * 1024;
  var DOC_EXTS = [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".jpg", ".jpeg", ".png", ".webp"];
  function safeName(n) { return String(n || "file").replace(/[^A-Za-z0-9._-]/g, "_"); }
  function storagePut(path, file) {
    var ref = firebase.storage().ref(path);
    return ref.put(file).then(function () { return ref.getDownloadURL(); });
  }
  function docFileOk(file) {
    if (!file || (file.size || 0) > DOC_MAX) return false;
    var t = file.type || "";
    if (t === "application/pdf" || t === "text/plain" || t.indexOf("image/") === 0 ||
        t.indexOf("word") >= 0 || t.indexOf("excel") >= 0 || t.indexOf("spreadsheet") >= 0 ||
        t.indexOf("officedocument") >= 0 || t.indexOf("msword") >= 0) return true;
    var n = (file.name || "").toLowerCase();
    return DOC_EXTS.some(function (e) { return n.slice(-e.length) === e; });
  }
  function addFileRecord(rec) {
    var r = currentRaise(); if (!r) return Promise.reject(new Error("no raise"));
    return raiseRef(r.id).collection("files").add(rec).then(function (ref) {
      rec.id = ref.id; state.files.push(rec); return rec;
    });
  }
  function loadFiles() {
    var r = currentRaise(); if (!r) return;
    raiseRef(r.id).collection("files").orderBy("createdAt", "asc").get().then(function (snap) {
      state.files = [];
      snap.forEach(function (d) { var f = d.data(); f.id = d.id; state.files.push(f); });
      renderPhotos(); renderFiles(); renderInvestors();
    }).catch(function () {});
  }
  function prefillProperty(r) {
    var p = (r && r.property) || {};
    function set(id, v) { var el = $(id); if (el) el.value = (v == null || v === 0) ? "" : v; }
    set("propAddress", p.address || ""); set("propType", p.type || "");
    set("propBeds", p.beds); set("propBaths", p.baths); set("propSqft", p.sqft);
    set("propPrice", p.price); set("propRehab", p.rehab); set("propArv", p.arv);
  }
  function saveProperty(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r) return;
    var p = {
      address: val("propAddress"), type: val("propType"),
      beds: num("propBeds"), baths: num("propBaths"), sqft: num("propSqft"),
      price: num("propPrice"), rehab: num("propRehab"), arv: num("propArv")
    };
    r.property = p;
    raiseRef(r.id).update({ property: p }).then(function () {
      setMsg("propMsg", "Property profile saved — it now leads this raise's pitch deck.", true);
    }).catch(function () { setMsg("propMsg", "Could not save the property profile.", false); });
  }
  function photoFiles() { return state.files.filter(function (f) { return f.kind === "photo"; }); }
  function uploadPhotos(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r || !state.user) return;
    var input = $("photoInput");
    var list = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (!list.length) { setMsg("photoMsg", "Choose at least one photo first.", false); return; }
    var hadHero = photoFiles().some(function (f) { return f.hero; });
    var done = 0, chain = Promise.resolve();
    list.forEach(function (file) {
      if (PHOTO_TYPES.indexOf(file.type) < 0) { setMsg("photoMsg", file.name + ": only JPG, PNG or WebP photos.", false); return; }
      if ((file.size || 0) > PHOTO_MAX) { setMsg("photoMsg", file.name + ": over the 10 MB photo limit.", false); return; }
      chain = chain.then(function () {
        var path = "syndicateUsers/" + state.user.uid + "/raises/" + r.id + "/photos/" +
          Date.now() + "-" + safeName(file.name);
        return storagePut(path, file).then(function (url) {
          var rec = {
            label: "Property photo", name: file.name, path: path, url: url, kind: "photo",
            investorId: "", hero: !hadHero && done === 0, size: file.size || 0, type: file.type || "",
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          };
          if (rec.hero) hadHero = true;
          done++;
          return addFileRecord(rec);
        });
      });
    });
    chain.then(function () {
      renderPhotos();
      if (done) setMsg("photoMsg", done + (done === 1 ? " photo" : " photos") + " uploaded — the hero photo now leads this raise's pitch deck.", true);
      if (input) input.value = "";
    }).catch(function () { setMsg("photoMsg", "Upload failed — check your connection and try again.", false); });
  }
  function renderPhotos() {
    var box = $("photoList"); if (!box) return;
    box.innerHTML = "";
    var photos = photoFiles();
    if (!photos.length) { box.innerHTML = "<p class='msg'>No property photos yet.</p>"; return; }
    photos.forEach(function (rec) {
      var row = document.createElement("div"); row.className = "checkitem";
      var img = document.createElement("img");
      img.setAttribute("src", rec.url); img.src = rec.url; img.alt = "";
      img.style.width = "110px"; img.style.borderRadius = "6px";
      var span = document.createElement("span");
      span.textContent = rec.name + (rec.hero ? " — HERO (leads the deck)" : "");
      row.appendChild(img); row.appendChild(span);
      if (!rec.hero) {
        var hb = document.createElement("button");
        hb.type = "button"; hb.className = "btn small ghost"; hb.textContent = "Make hero";
        hb.addEventListener("click", function () { makeHero(rec); });
        row.appendChild(hb);
      }
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn small ghost"; del.textContent = "Delete";
      del.addEventListener("click", function () { deleteFile(rec); });
      row.appendChild(del);
      box.appendChild(row);
    });
  }
  function makeHero(rec) {
    var r = currentRaise(); if (!r) return;
    photoFiles().forEach(function (f) {
      var was = f.hero === true; f.hero = (f === rec);
      if (was !== f.hero && f.id) raiseRef(r.id).collection("files").doc(f.id).update({ hero: f.hero }).catch(function () {});
    });
    renderPhotos();
    setMsg("photoMsg", "Hero photo set — it leads this raise's pitch deck.", true);
  }
  function deleteFile(rec) {
    var r = currentRaise(); if (!r) return;
    function after() {
      state.files = state.files.filter(function (f) { return f !== rec; });
      if (rec.kind === "photo") {
        var ph = photoFiles();
        if (ph.length && !ph.some(function (f) { return f.hero; })) {
          ph[0].hero = true;
          if (ph[0].id) raiseRef(r.id).collection("files").doc(ph[0].id).update({ hero: true }).catch(function () {});
        }
        renderPhotos();
      } else { renderFiles(); renderInvestors(); }
    }
    try { var del = firebase.storage().ref(rec.path).delete(); if (del && del.catch) del.catch(function () {}); } catch (e) {}
    if (rec.id) raiseRef(r.id).collection("files").doc(rec.id).delete().then(after).catch(after);
    else after();
  }
  function viewLink(rec) {
    var a = document.createElement("a");
    a.setAttribute("href", rec.url); a.href = rec.url;
    a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener");
    a.className = "btn small ghost"; a.textContent = "View / Download";
    return a;
  }
  function shareFile(rec, msgId) {
    var nav = window.navigator || {};
    function noted(extra) { setMsg(msgId, (extra ? extra + " " : "") + PRIVACY_LINE, true); }
    try {
      if (nav.share) {
        var p = nav.share({ title: rec.name, text: shareText(rec.name), url: rec.url });
        if (p && p.catch) p.catch(function () {});
        noted("");
        return;
      }
    } catch (e) { /* fall through to copy */ }
    if (nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(rec.url).then(function () { noted("Link copied."); }, function () { noted("Link: " + rec.url); });
      return;
    }
    noted("Link: " + rec.url);
  }
  function renderFiles() {
    var box = $("upFileList"); if (!box) return;
    box.innerHTML = "";
    var docs = state.files.filter(function (f) { return f.kind === "doc" && !f.investorId; });
    if (!docs.length) { box.innerHTML = "<p class='msg'>No documents attached yet.</p>"; return; }
    docs.forEach(function (rec) {
      var row = document.createElement("div"); row.className = "checkitem";
      var span = document.createElement("span");
      span.textContent = (rec.label ? rec.label + " — " : "") + rec.name;
      row.appendChild(span);
      row.appendChild(viewLink(rec));
      var sh = document.createElement("button");
      sh.type = "button"; sh.className = "btn small ghost"; sh.textContent = "Share";
      sh.addEventListener("click", function () { shareFile(rec, "upMsg"); });
      row.appendChild(sh);
      var del = document.createElement("button");
      del.type = "button"; del.className = "btn small ghost"; del.textContent = "Delete";
      del.addEventListener("click", function () { deleteFile(rec); });
      row.appendChild(del);
      box.appendChild(row);
    });
    var note = document.createElement("p");
    note.className = "msg"; note.textContent = PRIVACY_LINE;
    box.appendChild(note);
  }
  function uploadDoc(ev) {
    ev.preventDefault();
    var r = currentRaise(); if (!r || !state.user) return;
    var input = $("upFile");
    var file = input && input.files && input.files.length ? input.files[0] : null;
    if (!file) { setMsg("upMsg", "Choose a file first.", false); return; }
    if (!docFileOk(file)) { setMsg("upMsg", file.name + ": unsupported type, or over the 25 MB limit.", false); return; }
    var path = "syndicateUsers/" + state.user.uid + "/raises/" + r.id + "/docs/" +
      Date.now() + "-" + safeName(file.name);
    storagePut(path, file).then(function (url) {
      return addFileRecord({
        label: val("upLabel") || "Document", name: file.name, path: path, url: url, kind: "doc",
        investorId: "", hero: false, size: file.size || 0, type: file.type || "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      renderFiles();
      setMsg("upMsg", "Document uploaded and attached to this raise.", true);
      if (input) input.value = "";
    }).catch(function () { setMsg("upMsg", "Upload failed — check your connection and try again.", false); });
  }
  function uploadInvestorFile(invId, input) {
    var r = currentRaise(); if (!r || !state.user) return;
    var file = input && input.files && input.files.length ? input.files[0] : null;
    if (!file) return;
    if (!docFileOk(file)) { setMsg("detailMsg", file.name + ": unsupported type, or over the 25 MB limit.", false); return; }
    var path = "syndicateUsers/" + state.user.uid + "/raises/" + r.id + "/investors/" + invId +
      "/docs/" + Date.now() + "-" + safeName(file.name);
    storagePut(path, file).then(function (url) {
      return addFileRecord({
        label: "Investor document", name: file.name, path: path, url: url, kind: "doc",
        investorId: invId, hero: false, size: file.size || 0, type: file.type || "",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }).then(function () {
      renderInvestors();
      setMsg("detailMsg", "Document attached to the investor.", true);
    }).catch(function () { setMsg("detailMsg", "Upload failed — check your connection and try again.", false); });
  }

  /* ---------------- content generator ----------------
   * Same interaction pattern as the Trust Content Generator: pick a topic,
   * a format and an angle -> generated copy -> Copy button. Every output
   * carries the offers-grid link; public formats carry the disclaimer. */
  var CG_LINK = "https://madisonshalom72.github.io/capital-7-syndicate-24/offers-grid.html";
  var CG_DISCLAIMER = "Educational only \u2014 not legal or securities advice. Capital 7 Syndicate 24 is a planning tool \u2014 consult a securities attorney before structuring any raise.";
  var CG_CTA = "See every raise tool in one grid \u2014 Capital 7 Syndicate 24 runs the whole raise for $20/mo. Sign in free with Google.";
  var CG_TOPICS = [
    { id: "step1", name: "Step 1 \u2014 Structure the Company", body: "Step one is structure: the company gets structured correctly first \u2014 entity, ownership and paperwork in order \u2014 because boutique firms raise money for structured opportunities, and an unstructured company is not one." },
    { id: "step2", name: "Step 2 \u2014 Private Placement Memorandum", body: "Step two is the paper: the private placement memorandum puts the opportunity, the terms and the risks in writing \u2014 the document serious money reads before it moves." },
    { id: "step3", name: "Step 3 \u2014 Pitch Deck", body: "Step three is the story: a strong pitch deck \u2014 the company, the opportunity, the numbers, the ask. The memorandum is the legal paper; the deck is what gets the meeting." },
    { id: "step4", name: "Step 4 \u2014 Transfer Agent", body: "Step four is administration: a transfer agent handles the investor documentation properly \u2014 moving the information, the money and the paper between the company and the investor, and keeping the records straight." },
    { id: "step5", name: "Step 5 \u2014 Boutique Firms Raise It", body: "Step five is the raise itself: boutique investment firms exist to raise capital for structured opportunities. They go in and raise the money for you \u2014 and the model prices that work at around 1% of what they raise." },
    { id: "crm", name: "Capital 7 Syndicate 24 \u2014 The CRM", body: "Capital 7 Syndicate 24 runs the whole raise in one place \u2014 raises, investors, the document checklist, your boutique-firm list and the 1% fee math, tracked step by step for $20/mo." },
    { id: "deckgen", name: "Pitch Deck Generator", body: "The Pitch Deck Generator turns your story into a deck: fill in the problem, the solution, the use of funds and the ask, and get a black-and-gold deck you can page, print, download and share." },
    { id: "paperworkgen", name: "Paperwork Generator", body: "The Paperwork Generator assembles your own inputs into a private placement memorandum template, an investor intake form and a transfer-agent checklist \u2014 templates a securities attorney reviews and finalizes before any use." },
    { id: "calculator", name: "Raise Calculator", body: "The free Raise Calculator runs the boutique-fee math before you build the raise. Example only: on a $2,000,000 target, a ~1% boutique fee is $20,000, and at a $50,000 average check the raise takes about 40 investors \u2014 run your own numbers free." },
    { id: "loanable", name: "Loanable \u2014 Real Estate & Business Funding", body: "Not every deal is a raise. When the deal is a loan, the grid carries Loanable: real estate funding and a syndicated business line of credit \u2014 one tap from the same page as the raise tools." }
  ];
  var CG_ANGLES = {
    percent: { hook: "Where can you go and have people raise millions of dollars for you \u2014 and you pay them 1%?", line: "That is the model: the structure is right, the paper is ready, professionals raise the money, and the fee is around 1% of what they raise." },
    bankno: { hook: "The bank said no. That is not the end of the road \u2014 it is the start of a different one.", line: "Private capital does not move on a bank's checklist. It moves on structure, paper and presentation \u2014 in that order." },
    structure: { hook: "Money does not chase ideas. It chases structure.", line: "Structured companies get meetings. Structure comes first \u2014 before the deck, before the ask, before the money." },
    paperwork: { hook: "Serious money reads the paper before it moves.", line: "When the memorandum, the deck and the documents are ready, the whole conversation changes." },
    investor: { hook: "Investors do not fund confusion. They fund preparation.", line: "Show up investor-ready: structure done, paper done, numbers run \u2014 then let the firms do the raising." }
  };
  var CG_OPENERS = [
    "Most entrepreneurs were never taught this level of capital strategy.",
    "This is not motivation. This is financial infrastructure.",
    "When you understand how capital actually moves, you stop thinking small."
  ];
  var cgClicks = 0, cgLast = "";
  function cgTopicById(id) {
    for (var i = 0; i < CG_TOPICS.length; i++) if (CG_TOPICS[i].id === id) return CG_TOPICS[i];
    return CG_TOPICS[0];
  }
  function cgHashtags() { return "#RaiseCapital #CapitalRaising #PrivatePlacement #BusinessFunding #Capital7Syndicate24"; }
  function buildContentText() {
    var t = cgTopicById(($("cgTopic") || {}).value);
    var a = CG_ANGLES[($("cgAngle") || {}).value] || CG_ANGLES.percent;
    var f = (($("cgFormat") || {}).value) || "fb";
    var opener = CG_OPENERS[cgClicks % CG_OPENERS.length];
    var text = "";
    if (f === "ig") {
      text = a.hook + "\n\n" + t.body + "\n" + a.line + "\n\n" + CG_CTA + "\n" + CG_LINK + "\n.\n.\n" + cgHashtags() + "\n\n" + CG_DISCLAIMER;
    } else if (f === "ad") {
      text = "HEADLINE: " + a.hook + "\nAD: " + t.body + " " + CG_CTA + "\n" + CG_LINK + "\n\n" + CG_DISCLAIMER;
    } else if (f === "video") {
      text = "HOOK (0\u20133s, on camera): \u201C" + a.hook + "\u201D\n\nSCRIPT (3\u201325s): \u201C" + opener + " " + t.body + " " + a.line + "\u201D\n\nCTA (25\u201330s): \u201C" + CG_CTA + " Link: " + CG_LINK + "\u201D\n\nCaption: " + a.hook + " " + cgHashtags() + "\n" + CG_DISCLAIMER;
    } else if (f === "email") {
      text = "Subject: " + a.hook + "\n\n" + opener + "\n\n" + t.body + "\n" + a.line + "\n\n" + CG_CTA + "\n" + CG_LINK + "\n\n\u2014 Capital 7 Syndicate 24\n" + CG_DISCLAIMER;
    } else {
      text = a.hook + "\n\n" + opener + "\n\n" + t.body + "\n" + a.line + "\n\n" + CG_CTA + "\n" + CG_LINK + "\n\n" + cgHashtags() + "\n\n" + CG_DISCLAIMER;
    }
    cgClicks++;
    return text;
  }
  function generateContent() {
    var out = $("cgOut"); if (!out) return;
    cgLast = buildContentText();
    out.textContent = cgLast;
    out.classList.add("open");
    var copy = $("cgCopy");
    if (copy) { copy.disabled = false; copy.textContent = "Copy Generated Content"; }
  }
  function copyContent() {
    if (!cgLast) return;
    var copy = $("cgCopy");
    function done() {
      if (copy) { copy.textContent = "Copied \u2713"; setTimeout(function () { copy.textContent = "Copy Generated Content"; }, 1600); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cgLast).then(done, done);
    else done();
  }

  /* ---------------- wiring ---------------- */
  function on(id, ev, fn) { var el = $(id); if (el) el.addEventListener(ev, fn); }
  function wire() {
    on("calcBtn", "click", runCalc);
    on("signInBtn", "click", signIn);
    on("freeSignupBtn", "click", signIn);
    on("signupGoogleBtn", "click", signIn);
    on("signOutBtn", "click", signOut);
    on("planMonthlyBtn", "click", planAction);
    on("gateMonthlyBtn", "click", planAction);
    on("gateCloseBtn", "click", closeGate);
    on("raiseForm", "submit", addRaise);
    on("investorForm", "submit", addInvestor);
    on("firmForm", "submit", addFirm);
    on("deckForm", "submit", buildDeck);
    on("deckPrintBtn", "click", printDeck);
    on("docForm", "submit", buildMemorandum);
    on("intakeBtn", "click", buildIntake);
    on("agentBtn", "click", buildAgentLetter);
    on("docPrintBtn", "click", printDoc);
    on("propForm", "submit", saveProperty);
    on("photoForm", "submit", uploadPhotos);
    on("upForm", "submit", uploadDoc);
    var cgSel = $("cgTopic");
    if (cgSel) cgSel.innerHTML = CG_TOPICS.map(function (t) {
      return "<option value='" + t.id + "'>" + esc(t.name) + "</option>";
    }).join("");
    on("cgGenerate", "click", generateContent);
    on("cgCopy", "click", copyContent);
    var openers = document.querySelectorAll("[data-open-crm]");
    for (var i = 0; i < openers.length; i++) (function (el) {
      el.addEventListener("click", function (ev) { if (ev && ev.preventDefault) ev.preventDefault(); openCRM(); });
    })(openers[i]);
    runCalc();
  }

  function init() {
    wire();
    if (typeof firebase === "undefined" || !window.SYNDICATE_FIREBASE_CONFIG) {
      setMsg("signupMsg", "Sign-in is unavailable right now — the roadmap and calculator still work.", false);
      return;
    }
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(window.SYNDICATE_FIREBASE_CONFIG);
      state.auth = firebase.auth();
      state.db = firebase.firestore();
      state.auth.onAuthStateChanged(onAuth);
    } catch (e) {
      setMsg("signupMsg", "Sign-in is unavailable right now — the roadmap and calculator still work.", false);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
