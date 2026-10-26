//! Pruebas del hub (tareas, buzón, guardado).

#[cfg(test)]
mod task_tests {
    use crate::hub::*;

    fn task(id: u64, status: &str, parents: &[u64]) -> Task {
        let mut t = Task::new(id, format!("t{id}"), String::new(), parents.to_vec());
        t.status = status.into();
        t
    }

    #[test]
    fn unmet_parents_lists_only_pending_ones() {
        let tasks = vec![task(1, "done", &[]), task(2, "claimed", &[]), task(3, "open", &[1, 2])];
        assert_eq!(unmet_parents(&tasks, &tasks[2]), vec![2]);
    }

    #[test]
    fn missing_parent_counts_as_met() {
        let tasks = vec![task(3, "open", &[9])];
        assert!(unmet_parents(&tasks, &tasks[0]).is_empty());
    }

    #[test]
    fn check_parents_rejects_unknown_and_dedupes() {
        let tasks = vec![task(1, "open", &[]), task(2, "open", &[])];
        assert_eq!(check_parents(&tasks, &[2, 1, 2]).unwrap(), vec![2, 1]);
        assert!(check_parents(&tasks, &[7]).is_err());
    }

    #[test]
    fn old_state_without_new_fields_still_loads() {
        let json = r#"{"id":1,"title":"x","status":"open","created_ms":5}"#;
        let t: Task = serde_json::from_str(json).unwrap();
        assert!(t.parents.is_empty() && t.result.is_none());
    }
}

#[cfg(test)]
mod inbox_tests {
    use crate::hub::*;

    #[test]
    fn eventos_de_una_ventana_con_el_archivo() {
        let ev = |seq: u64, ts: u64| Event { seq, ts_ms: ts, agent: "a".into(), session_id: String::new(), kind: "message".into(), text: format!("e{seq}"), files: vec![], to: None, task_id: None };
        let dir = std::env::temp_dir().join(format!("lienzo-evr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let arch = dir.join("x.jsonl");
        let lines: String = [ev(1, 100), ev(2, 200), ev(3, 300)].iter().map(|e| serde_json::to_string(e).unwrap() + "\n").collect();
        std::fs::write(&arch, lines).unwrap();
        std::fs::write(arch.with_extension("old.jsonl"), serde_json::to_string(&ev(0, 50)).unwrap() + "\n").unwrap();
        // El 3 está también en el feed vivo: no se repite.
        let live = vec![ev(3, 300), ev(4, 400), ev(5, 500)];
        let got: Vec<u64> = events_between(live.clone(), &arch, 0, 450, 100).iter().map(|e| e.seq).collect();
        assert_eq!(got, [0, 1, 2, 3, 4]);
        let got: Vec<u64> = events_between(live.clone(), &arch, 350, u64::MAX, 100).iter().map(|e| e.seq).collect();
        assert_eq!(got, [4, 5]);
        // Con tope, se quedan los más nuevos.
        let got: Vec<u64> = events_between(live, &arch, 0, u64::MAX, 2).iter().map(|e| e.seq).collect();
        assert_eq!(got, [4, 5]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn hub() -> HubInner {
        HubInner {
            token: String::new(),
            port: 0,
            agents: HashMap::new(),
            events: VecDeque::new(),
            tasks: vec![],
            claims: HashMap::new(),
            project: None,
            charter: None,
            leader: Some("claude".into()),
            broadcasts: VecDeque::new(),
            memory: vec![],
            memory_seq: 0,
            broadcast_marks: HashMap::new(),
            inbox_marks: HashMap::new(),
            inbox_floor: 0,
            usage: HashMap::new(),
            usage_since: 0,
            usage_seen: VecDeque::new(),
            director: false,
            fix_limit: 0,
            plan_hold: false,
            isolate: false,
            bases: HashMap::new(),
            focus: HashMap::new(),
            strengths: HashMap::new(),
            questions: Vec::new(),
            question_seq: 0,
            schedules: Vec::new(),
            schedule_seq: 0,
            projects: HashMap::new(),
            limits: HashMap::new(),
            seq: 0,
            task_seq: 0,
        }
    }

    #[test]
    fn renombrar_proyecto_abierto_y_guardado() {
        let mut h = hub();
        h.project = Some(r"C:\x\Viejo".into());
        h.tasks.push(Task::new(1, "t".into(), String::new(), vec![]));
        assert!(rename_project(&mut h, r"C:\x\viejo\", r"C:\x\Nuevo"));
        assert_eq!(h.project.as_deref(), Some(r"C:\x\Nuevo"));
        assert_eq!(h.tasks.len(), 1);
        // Uno guardado (no abierto) cambia de estante con sus tareas.
        switch_project(&mut h, Some(r"C:\x\Otro".into()));
        assert!(rename_project(&mut h, r"C:\x\Nuevo", r"C:\x\Final"));
        assert!(!h.projects.contains_key("c:/x/nuevo"));
        let slot = &h.projects["c:/x/final"];
        assert_eq!(slot.path, r"C:\x\Final");
        assert_eq!(slot.tasks.len(), 1);
        assert!(!rename_project(&mut h, r"C:\x\NoExiste", r"C:\x\Y"));
    }

    fn msg(h: &mut HubInner, from: &str, to: Option<&str>, text: &str) -> u64 {
        let to = message_target(h, to.map(|s| s.to_string()));
        push_event(h, from, "s", "message", text, vec![], to).seq
    }

    #[test]
    fn inbox_gets_direct_and_team_messages_but_not_own_or_user() {
        let mut h = hub();
        msg(&mut h, "opencode", Some("claude"), "para ti");
        msg(&mut h, "opencode", None, "para todos");
        msg(&mut h, "opencode", Some("antigravity"), "para otro");
        msg(&mut h, "claude", None, "mío");
        msg(&mut h, "tú", Some("claude"), "del usuario");
        let texts: Vec<&str> = inbox_unread(&h, "claude").iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["para ti", "para todos"]);
    }

    #[test]
    fn leader_alias_and_ack() {
        let mut h = hub();
        let seq = msg(&mut h, "opencode", Some("líder"), "hola líder");
        assert_eq!(inbox_unread(&h, "claude").len(), 1);
        inbox_ack(&mut h, "Claude", seq);
        assert!(inbox_unread(&h, "claude").is_empty());
    }

    #[test]
    fn messages_before_start_count_as_read() {
        let mut h = hub();
        msg(&mut h, "opencode", Some("claude"), "viejo");
        h.inbox_floor = h.seq;
        msg(&mut h, "opencode", Some("claude"), "nuevo");
        let texts: Vec<&str> = inbox_unread(&h, "claude").iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts, vec!["nuevo"]);
    }

    #[test]
    fn usage_counts_each_message_once() {
        let mut h = hub();
        report_usage(&mut h, "claude", "cc:1", 10, 5, 100, 20);
        report_usage(&mut h, "claude", "cc:1", 10, 5, 100, 20);
        report_usage(&mut h, "claude", "cc:2", 1, 1, 1, 1);
        let u = &h.usage["claude"];
        assert_eq!((u.input, u.output, u.cache_read, u.cache_write, u.turns), (11, 6, 101, 21, 2));
    }

    #[test]
    fn big_context_drop_counts_as_freed() {
        let mut h = hub();
        h.agents.insert(
            "s1".into(),
            AgentInfo {
                session_id: "s1".into(),
                name: "claude".into(),
                project: String::new(),
                pid: 0,
                last_seen_ms: now_ms(),
                model: None,
                ctx_tokens: Some(150_000),
                ctx_window: Some(200_000),
                ctx_ms: None,
                cli_session: None,
            },
        );
        report_ctx(&mut h, "s1", "claude", None, Some(20_000), None);
        report_ctx(&mut h, "s1", "claude", None, Some(25_000), None);
        let u = &h.usage["claude"];
        assert_eq!((u.freed, u.compactions), (130_000, 1));
    }

    fn join(h: &mut HubInner, name: &str) {
        h.agents.insert(
            name.into(),
            AgentInfo {
                session_id: name.into(),
                name: name.into(),
                project: String::new(),
                pid: 0,
                last_seen_ms: now_ms(),
                model: None,
                ctx_tokens: None,
                ctx_window: None,
                ctx_ms: None,
                cli_session: None,
            },
        );
    }

    /// Hub en modo director con una tarea #1 de opencode entregada y en revisión.
    fn delivered() -> HubInner {
        let mut h = hub();
        h.director = true;
        join(&mut h, "claude");
        let mut t = Task::new(1, "login".into(), String::new(), vec![]);
        t.status = "review".into();
        t.owner = "opencode".into();
        t.result = Some(TaskResult {
            summary: "hecho".into(),
            files: vec!["src/a.ts".into()],
            evidence: "npm test ok".into(),
            by: "opencode".into(),
            ts_ms: 0,
            diff: String::new(),
        });
        h.tasks.push(t);
        h
    }

    #[test]
    fn director_reviews_only_workers_with_leader_online() {
        let mut h = hub();
        assert_eq!(reviewer_for(&h, "opencode"), None, "sin modo director no hay revisión");
        h.director = true;
        assert_eq!(reviewer_for(&h, "opencode").as_deref(), Some("claude"), "aunque esté desconectado, la entrega le espera");
        h.leader = None;
        assert_eq!(reviewer_for(&h, "opencode"), None, "sin líder no hay revisión");
        h.leader = Some("claude".into());
        assert_eq!(reviewer_for(&h, "claude"), None, "el líder no se revisa a sí mismo");
        assert_eq!(reviewer_for(&h, "tú"), None);
    }

    #[test]
    fn review_request_reaches_leader_inbox() {
        let mut h = delivered();
        ask_review(&mut h, 1, "claude");
        let inbox = inbox_unread(&h, "claude");
        assert_eq!(inbox.len(), 1);
        assert!(inbox[0].text.contains("#1") && inbox[0].text.contains("npm test ok"));
    }

    #[test]
    fn fix_goes_back_to_owner_until_limit() {
        let mut h = delivered();
        assert!(review_task(&mut h, 1, "opencode", "s", "ok", "").is_err(), "un trabajador no se aprueba");
        assert!(review_task(&mut h, 1, "claude", "s", "fix", "  ").is_err(), "fix pide órdenes");
        review_task(&mut h, 1, "claude", "s", "fix", "falta el test de error").unwrap();
        assert_eq!((h.tasks[0].status.as_str(), h.tasks[0].fix_rounds), ("claimed", 1));
        let orders = inbox_unread(&h, "opencode");
        assert!(orders.iter().any(|e| e.text.contains("falta el test de error")));
        h.tasks[0].status = "review".into();
        review_task(&mut h, 1, "claude", "s", "fix", "otra vez").unwrap();
        h.tasks[0].status = "review".into();
        assert!(review_task(&mut h, 1, "claude", "s", "fix", "y otra").is_err(), "tope de rondas");
        review_task(&mut h, 1, "claude", "s", "take", "").unwrap();
        assert_eq!((h.tasks[0].status.as_str(), h.tasks[0].owner.as_str()), ("claimed", "claude"));
    }

    #[test]
    fn ok_closes_and_unblocks_children() {
        let mut h = delivered();
        h.tasks.push(Task::new(2, "hija".into(), String::new(), vec![1]));
        assert_eq!(unmet_parents(&h.tasks, &h.tasks[1]), vec![1], "en revisión aún bloquea");
        review_task(&mut h, 1, "tú", "ui", "ok", "").unwrap();
        assert_eq!(h.tasks[0].status, "done");
        assert!(unmet_parents(&h.tasks, &h.tasks[1]).is_empty());
    }

    fn with_codex(h: &mut HubInner, used_pct: f64) {
        join(h, "codex");
        h.limits.insert(
            "codex".into(),
            serde_json::json!({ "windows": [ { "key": "week", "label": "Semana", "used_pct": used_pct } ], "exact": true }),
        );
    }

    #[test]
    fn codex_revisa_primero_lo_simple_y_medio() {
        let mut h = delivered();
        with_codex(&mut h, 10.0);
        h.tasks[0].level = "simple".into();
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("codex"));
        h.tasks[0].level = "media".into();
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("codex"));
        h.tasks[0].level = "dificil".into();
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("claude"), "lo difícil, al líder");
        h.tasks[0].level = String::new();
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("claude"), "sin nivel, al líder");
        h.tasks[0].level = "simple".into();
        assert_eq!(reviewer_for_task(&h, "codex", 1).as_deref(), Some("claude"), "lo de Codex lo revisa el líder");
        with_codex(&mut h, 85.0);
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("claude"), "Codex sin cuota: al líder");
        let mut off = delivered();
        off.tasks[0].level = "simple".into();
        assert_eq!(reviewer_for_task(&off, "opencode", 1).as_deref(), Some("claude"), "Codex desconectado: al líder");
    }

    #[test]
    fn el_ritmo_de_las_cuotas_decide_quien_revisa() {
        let now = now_ms();
        let h3 = 3_600_000u64;
        let week = |used: f64, left_h: u64| {
            serde_json::json!({ "windows": [ { "key": "week", "label": "Semana", "used_pct": used, "resets_at": now + left_h * h3 } ] })
        };
        // A mitad de semana: 40 % va 10 por debajo; 70 %, 20 por delante.
        assert_eq!(limits_pace(&week(40.0, 84), now).round(), -10.0);
        assert_eq!(limits_pace(&week(70.0, 84), now).round(), 20.0);
        assert_eq!(limits_pace(&week(85.0, 84), now), f64::INFINITY);
        let mut h = delivered();
        with_codex(&mut h, 10.0);
        h.tasks[0].level = "media".into();
        h.limits.insert("codex".into(), week(60.0, 84));
        h.limits.insert("claude".into(), week(40.0, 84));
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("codex"), "20 de diferencia no basta: revisar le cuesta más al líder");
        h.limits.insert("codex".into(), week(75.0, 120));
        h.limits.insert("claude".into(), week(5.0, 60));
        assert_eq!(reviewer_for_task(&h, "opencode", 1).as_deref(), Some("claude"), "Codex va muy por delante y el líder sobrado");
    }

    #[test]
    fn codex_aprueba_corrige_o_pasa_al_lider() {
        let mut h = delivered();
        with_codex(&mut h, 10.0);
        h.tasks[0].level = "simple".into();
        ask_review(&mut h, 1, "codex");
        assert_eq!(h.tasks[0].reviewer, "codex");
        let msg = inbox_unread(&h, "codex");
        assert!(msg.len() == 1 && msg[0].text.contains("primer revisor") && msg[0].text.starts_with("🔎 Revisa la entrega de #1"));
        assert!(inbox_unread(&h, "claude").is_empty(), "al líder no lo despierta");
        assert!(review_task(&mut h, 1, "opencode", "s", "ok", "").is_err(), "quien entrega no se aprueba");
        // Lo que no tiene claro vuelve al líder (también si pide take), con su nota.
        review_task(&mut h, 1, "codex", "s", "lider", "toca el login").unwrap();
        assert_eq!((h.tasks[0].status.as_str(), h.tasks[0].reviewer.as_str()), ("review", "claude"));
        let lead = inbox_unread(&h, "claude");
        assert!(lead.iter().any(|e| e.text.contains("#1") && e.text.contains("take (la haces tú)")));
        assert!(review_task(&mut h, 1, "codex", "s", "ok", "").is_err(), "ya no es suya");
        review_task(&mut h, 1, "claude", "s", "ok", "").unwrap();
        assert_eq!(h.tasks[0].status, "done");
    }

    #[test]
    fn codex_aprueba_y_tras_las_rondas_la_pasa() {
        let mut h = delivered();
        with_codex(&mut h, 10.0);
        ask_review(&mut h, 1, "codex");
        review_task(&mut h, 1, "codex", "s", "fix", "falta el test").unwrap();
        h.tasks[0].status = "review".into();
        review_task(&mut h, 1, "codex", "s", "fix", "otra vez").unwrap();
        h.tasks[0].status = "review".into();
        let err = review_task(&mut h, 1, "codex", "s", "fix", "y otra").unwrap_err();
        assert!(err.contains("verdict lider"), "{err}");
        review_task(&mut h, 1, "codex", "s", "take", "").unwrap();
        assert_eq!((h.tasks[0].owner.as_str(), h.tasks[0].reviewer.as_str()), ("opencode", "claude"), "take = al líder, no se la queda");
        let mut ok = delivered();
        with_codex(&mut ok, 10.0);
        ask_review(&mut ok, 1, "codex");
        review_task(&mut ok, 1, "codex", "s", "ok", "").unwrap();
        assert_eq!(ok.tasks[0].status, "done");
    }

    #[test]
    fn la_revision_vuelve_al_lider_si_codex_no_puede() {
        let mut h = delivered();
        with_codex(&mut h, 10.0);
        ask_review(&mut h, 1, "codex");
        assert!(!reroute_reviews(&mut h), "Codex disponible y a tiempo: sigue con él");
        with_codex(&mut h, 90.0);
        assert!(reroute_reviews(&mut h));
        assert_eq!(h.tasks[0].reviewer, "claude");
        assert!(inbox_unread(&h, "claude").iter().any(|e| e.text.contains("#1")));
        assert!(!reroute_reviews(&mut h), "una sola vez");
        // Demasiado tiempo sin decidir, también.
        let mut slow = delivered();
        with_codex(&mut slow, 10.0);
        ask_review(&mut slow, 1, "codex");
        slow.tasks[0].review_ms = now_ms() - FIRST_REVIEWER_WAIT_MS - 1;
        assert!(reroute_reviews(&mut slow));
        assert_eq!(slow.tasks[0].reviewer, "claude");
    }

    #[test]
    fn leader_back_gets_one_reminder_of_pending_reviews() {
        let mut h = delivered();
        remind_reviews(&mut h, "claude");
        remind_reviews(&mut h, "claude");
        let inbox = inbox_unread(&h, "claude");
        assert_eq!(inbox.len(), 1, "un solo recordatorio aunque se conecte dos veces");
        assert!(inbox[0].text.contains("#1"));
        remind_reviews(&mut h, "opencode");
        assert!(inbox_unread(&h, "opencode").is_empty(), "solo al líder");
    }

    #[test]
    fn usage_goes_to_the_task_in_focus_until_it_is_not_theirs() {
        let mut h = delivered();
        h.tasks[0].status = "claimed".into();
        set_focus(&mut h, "opencode", 1);
        report_usage(&mut h, "opencode", "oc:1", 100, 10, 0, 0);
        h.tasks[0].status = "review".into();
        set_focus(&mut h, "claude", 1);
        report_usage(&mut h, "claude", "cc:1", 5, 50, 1000, 0);
        review_task(&mut h, 1, "claude", "s", "ok", "").unwrap();
        report_usage(&mut h, "claude", "cc:2", 1, 1, 1, 1);
        report_usage(&mut h, "claude", "cc:3", 7, 7, 7, 7);
        let cost = &h.tasks[0].cost;
        assert_eq!((cost["opencode"].input, cost["claude"].output, cost["claude"].turns), (100, 51, 2));
        assert!(!h.focus.contains_key("claude"), "tras cerrarla, su gasto ya no cuenta para la tarea");
        assert_eq!(h.usage["claude"].turns, 3);
    }

    #[test]
    fn user_schedules_start_active_and_can_be_edited() {
        let mut h = hub();
        let d = schedule::Draft {
            title: "Informe diario".into(),
            notes: "Resume lo hecho ayer en propuestas/diario.md".into(),
            every: "lun-vie 8:30".into(),
            chat: "c1".into(),
            chat_title: "Hermes".into(),
            ..Default::default()
        };
        let s = schedule::create_by_user(&mut h, &d).unwrap();
        assert_eq!((s.status.as_str(), s.chat.as_str()), ("active", "c1"));
        assert!(h.events.back().unwrap().text.contains("creada"), "sin el aviso de pendiente");
        let s2 = schedule::update(&mut h, s.id, &schedule::Draft { every: "cada 2 h".into(), ..d.clone() }).unwrap();
        assert_eq!((s2.every.as_str(), s2.status.as_str()), ("cada 2 h", "active"));
        assert!(schedule::update(&mut h, s.id, &schedule::Draft { every: "a veces".into(), ..d }).is_err());
        schedule::link(&mut h, s.id, "c2", "Odysseus").unwrap();
        assert_eq!(h.schedules[0].chat_title, "Odysseus");
    }

    #[test]
    fn schedules_wait_for_approval_and_do_not_pile_up() {
        let mut h = hub();
        let s = schedule::create(&mut h, "claude", "s", "Revisar enlaces rotos", "Recorre docs/ y anota los rotos", "cada día 9:00", "opencode", "simple", "", 2).unwrap();
        assert_eq!(s.status, "pending");
        assert!(schedule::create(&mut h, "claude", "s", "x", "y", "a veces", "", "", "", 0).is_err(), "frecuencia rara");
        assert!(schedule::fire(&mut h, s.id, "2026-10-22", None, false).is_err(), "sin tu OK no corre");
        schedule::op(&mut h, s.id, "approve").unwrap();
        let t1 = schedule::fire(&mut h, s.id, "2026-10-22", None, false).unwrap().expect("crea la tarea");
        let task = h.tasks.iter().find(|t| t.id == t1).unwrap();
        assert_eq!((task.schedule, task.status.as_str(), task.level.as_str()), (s.id, "open", "simple"));
        assert!(!task.assign.is_empty());
        assert_eq!(schedule::fire(&mut h, s.id, "2026-10-22", None, false).unwrap(), None, "la anterior sin acabar");
        h.tasks.iter_mut().find(|t| t.id == t1).unwrap().status = "done".into();
        let t2 = schedule::fire(&mut h, s.id, "2026-10-22", None, false).unwrap();
        assert!(t2.is_some());
        h.tasks.iter_mut().find(|t| Some(t.id) == t2).unwrap().status = "done".into();
        assert_eq!(schedule::fire(&mut h, s.id, "2026-10-22", None, false).unwrap(), None, "tope diario de 2");
        assert!(schedule::fire(&mut h, s.id, "2026-10-23", None, false).unwrap().is_some(), "otro día, otra vez");
        let last = h.schedules[0].last_task;
        h.tasks.iter_mut().find(|t| t.id == last).unwrap().status = "done".into();
        assert_eq!(schedule::fire(&mut h, s.id, "2026-10-23", Some("claude va por el 85 %"), false).unwrap(), None);
        assert_eq!(h.schedules[0].skipped, "claude va por el 85 %");
        schedule::op(&mut h, s.id, "delete").unwrap();
        assert!(h.schedules.is_empty());
    }

    #[test]
    fn feed_search_matches_words_agents_and_task_ids() {
        let mut h = hub();
        push_event_full(&mut h, "opencode", "s", "update", "Clon de Odysseus listo", vec![], None, Some(63));
        push_event_full(&mut h, "claude", "s", "message", "Revisa la parte B de Hermes", vec![], None, None);
        push_event_full(&mut h, "claude", "s", "join", "entró odysseus", vec![], None, None);
        let texts = |v: Vec<Event>| v.into_iter().map(|e| e.text).collect::<Vec<_>>();
        assert_eq!(texts(search_feed(&h, "odysseus", "", 10)), vec!["Clon de Odysseus listo"], "sin el ruido de entrar");
        assert_eq!(texts(search_feed(&h, "#63", "", 10)), vec!["Clon de Odysseus listo"]);
        assert_eq!(texts(search_feed(&h, "parte hermes", "claude", 10)), vec!["Revisa la parte B de Hermes"]);
        assert!(search_feed(&h, "hermes", "opencode", 10).is_empty());
        assert!(search_feed(&h, "  ", "", 10).is_empty());
    }

    #[test]
    fn claim_keys_ignore_how_the_path_is_written() {
        let k = claim_key(r"C:\Users\X\revision\arbol.md");
        for p in ["c:/users/x/revision/arbol.md", r"C:\Users\X\\revision\.\arbol.md", "C:/Users/X/tmp/../revision/arbol.md "] {
            assert_eq!(claim_key(p), k, "{p}");
        }
        assert_eq!(claim_key(r"\\nas\share\a.md"), "//nas/share/a.md");
        assert_ne!(claim_key(r"C:\a\hermes\revision\arbol.md"), claim_key(r"C:\a\orca\revision\arbol.md"));
    }

    #[test]
    fn leader_hands_off_a_stalled_task() {
        let mut h = hub();
        let mut t = Task::new(1, "parte B".into(), String::new(), vec![]);
        t.status = "claimed".into();
        t.owner = "opencode".into();
        h.tasks.push(t);
        assert!(handoff_task(&mut h, 1, "opencode", "s", "antigravity", "").is_err(), "solo el líder");
        handoff_task(&mut h, 1, "claude", "s", "antigravity", "se paró dos veces").unwrap();
        let t = &h.tasks[0];
        assert_eq!((t.status.as_str(), t.owner.as_str()), ("open", ""));
        assert!(!t.assign.is_empty());
        let told = h.events.iter().any(|e| e.kind == "message" && e.to.as_deref() == Some("opencode"));
        assert!(told, "su antiguo dueño recibe la orden de dejarla");
    }

    #[test]
    fn plan_tasks_wait_for_approval() {
        let mut h = hub();
        h.plan_hold = true;
        for (id, status) in [(1, "plan"), (2, "plan"), (3, "open")] {
            let mut t = Task::new(id, format!("t{id}"), String::new(), vec![]);
            t.status = status.into();
            h.tasks.push(t);
        }
        // El encargo de una tarea del plan no la suelta antes de tiempo.
        brief_task(&mut h, 1, "claude", "s", "Objetivo: …", "", "").unwrap();
        assert_eq!(h.tasks[0].status, "plan");
        assert_eq!(approve_plan(&mut h, "tú", "ui"), vec![1, 2]);
        assert!(!h.plan_hold);
        assert!(h.tasks.iter().all(|t| t.status == "open"));
        assert!(approve_plan(&mut h, "tú", "ui").is_empty(), "aprobar dos veces no hace nada");
    }

    #[test]
    fn discarding_a_plan_drops_only_its_tasks() {
        let mut h = hub();
        h.plan_hold = true;
        for (id, status) in [(1, "plan"), (2, "claimed")] {
            let mut t = Task::new(id, format!("t{id}"), String::new(), vec![]);
            t.status = status.into();
            h.tasks.push(t);
        }
        assert_eq!(discard_plan(&mut h, "tú", "ui"), vec![1]);
        assert_eq!(h.tasks.iter().map(|t| t.id).collect::<Vec<_>>(), vec![2]);
        assert!(!h.plan_hold);
    }

    #[test]
    fn brief_opens_a_draft_only_for_the_leader() {
        let mut h = hub();
        let mut t = Task::new(1, "login".into(), String::new(), vec![]);
        t.status = "draft".into();
        h.tasks.push(t);
        assert!(brief_task(&mut h, 1, "opencode", "s", "hazlo", "", "").is_err());
        assert!(brief_task(&mut h, 1, "claude", "s", "  ", "", "").is_err(), "sin encargo no");
        brief_task(&mut h, 1, "claude", "s", "Objetivo: …", "Fácil", "OpenCode").unwrap();
        let t = &h.tasks[0];
        assert_eq!((t.status.as_str(), t.level.as_str(), t.assign.as_str()), ("open", "simple", "OpenCode"));
    }

    #[test]
    fn levels_are_normalized() {
        assert_eq!(task_level("Difícil"), "dificil");
        assert_eq!(task_level("fácil"), "simple");
        assert_eq!(task_level("??"), "");
    }

    #[test]
    fn preguntas_al_usuario() {
        let mut h = hub();
        // Validación: opciones mínimas y número de preguntas.
        assert!(clean_questions(&serde_json::json!([])).is_err());
        assert!(clean_questions(&serde_json::json!([{ "question": "¿Color?", "options": ["Azul"] }])).is_err());
        let items = clean_questions(&serde_json::json!([
            { "question": "¿Qué estilo?", "header": "Estilo", "options": [
                { "label": "Minimalista", "description": "Mucho blanco" }, "Colorido" ] },
            { "question": "¿Qué incluye?", "options": ["Login", "Pagos", "Blog"], "multiSelect": true }
        ]))
        .unwrap();
        assert_eq!(items[0].options[1].label, "Colorido");
        assert!(items[1].multi);

        // Contestada mientras la herramienta espera: no hay que escribir en la terminal.
        let id = ask_user(&mut h, "claude", "s1", "Antes de diseñar", items.clone());
        assert!(h.events.back().unwrap().text.starts_with(&format!("❓ q{id} · ¿Qué estilo? (+1)")));
        let (agent, late) = answer_question(
            &mut h,
            id,
            Some(vec![
                QAnswer { question: "¿Qué estilo?".into(), choices: vec!["Minimalista".into()], other: String::new() },
                QAnswer { question: "¿Qué incluye?".into(), choices: vec!["Login".into(), "Blog".into()], other: "SEO".into() },
            ]),
        )
        .unwrap();
        assert_eq!((agent.as_str(), late), ("claude", None));
        let text = detach_question(&mut h, id).unwrap();
        assert!(text.contains("1. ¿Qué estilo? → Minimalista"));
        assert!(text.contains("2. ¿Qué incluye? → Login, Blog; otra: SEO"));
        assert!(answer_question(&mut h, id, None).is_err());

        // La herramienta dejó de esperar: la respuesta va a la terminal.
        let id2 = ask_user(&mut h, "opencode", "s2", "", items);
        assert_eq!(detach_question(&mut h, id2), None);
        let (_, late) = answer_question(&mut h, id2, None).unwrap();
        assert!(late.unwrap().contains("prefirió no contestar"));

        // Su herramienta murió esperando (p. ej. se reinició Prometeo): ya no pregunta, así que
        // la respuesta, entera, va a la terminal aunque nadie la soltara.
        let two = clean_questions(&serde_json::json!([
            { "question": "¿Uno?", "options": ["A", "B"] }, { "question": "¿Dos?", "options": ["C", "D"] }
        ]))
        .unwrap();
        let id3 = ask_user(&mut h, "claude", "s3", "", two);
        let q = h.questions.iter_mut().find(|q| q.id == id3).unwrap();
        q.ts_ms -= ASK_GONE_MS + 5_000;
        q.polled_ms = q.ts_ms;
        let (_, late) = answer_question(
            &mut h,
            id3,
            Some(vec![
                QAnswer { question: "¿Uno?".into(), choices: vec!["A".into()], other: String::new() },
                QAnswer { question: "¿Dos?".into(), choices: vec!["D".into()], other: String::new() },
            ]),
        )
        .unwrap();
        let late = late.expect("debe ir a la terminal");
        assert!(late.contains("1. ¿Uno? → A") && late.contains("2. ¿Dos? → D"), "{late}");
    }

    #[test]
    fn cada_carpeta_con_lo_suyo() {
        let mut h = hub();
        h.project = Some("C:\\Users\\yo\\juego".into());
        h.tasks.push(Task::new(1, "Hacer el juego".into(), String::new(), vec![]));
        h.charter = Some("Normas del juego".into());
        push_event(&mut h, "claude", "s1", "update", "trabajando en el juego", vec![], None);

        // A otra carpeta (con barra final): empieza vacía.
        assert!(switch_project(&mut h, Some("C:\\Users\\yo\\revisiones\\".into())));
        assert_eq!(h.project.as_deref(), Some("C:\\Users\\yo\\revisiones"));
        assert!(h.tasks.is_empty() && h.events.is_empty() && h.charter.is_none());
        h.tasks.push(Task::new(2, "Revisar".into(), String::new(), vec![]));
        let list = project_list(&h);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["path"], "C:\\Users\\yo\\juego");
        assert_eq!(list[0]["open_tasks"], 1);

        // Volver (aunque cambien mayúsculas o barras) trae lo de antes.
        assert!(switch_project(&mut h, Some("c:/users/yo/JUEGO".into())));
        assert_eq!(h.tasks[0].title, "Hacer el juego");
        assert_eq!(h.charter.as_deref(), Some("Normas del juego"));
        assert_eq!(h.events.len(), 1);
        assert!(!switch_project(&mut h, Some("C:\\Users\\yo\\juego".into())));
        assert!(switch_project(&mut h, Some("C:\\Users\\yo\\revisiones".into())));
        assert_eq!(h.tasks[0].title, "Revisar");
    }
}

#[cfg(test)]
mod persist_tests {
    use crate::hub::*;
    use std::path::{Path, PathBuf};

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lienzo-state-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn state(seq: u64) -> String {
        let s = PersistedState { leader: Some("claude".into()), seq, ..Default::default() };
        serde_json::to_string(&s).unwrap()
    }

    fn corrupt_files(d: &Path) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = std::fs::read_dir(d)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.to_string_lossy().contains(".corrupt-"))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn writes_atomically_and_keeps_backup() {
        let d = dir("write");
        let main = d.join("team-state.json");
        let (s, warn) = load_state_from(&main);
        assert!(s.leader.is_none() && warn.is_none(), "la primera vez no hay nada ni se avisa");
        write_state_to(&main, &state(1)).unwrap();
        write_state_to(&main, &state(2)).unwrap();
        assert_eq!(load_state_from(&main).0.seq, 2);
        assert_eq!(read_state(&backup_path(&main)).unwrap().unwrap().seq, 1);
        let names: Vec<String> =
            std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into()).collect();
        assert!(names.iter().all(|n| !n.contains(".tmp")), "no quedan temporales: {names:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn truncated_state_recovers_from_backup() {
        let d = dir("trunc");
        let main = d.join("team-state.json");
        write_state_to(&main, &state(1)).unwrap();
        write_state_to(&main, &state(2)).unwrap();
        // Cierre a mitad de escritura: el principal se queda a medias.
        let raw = std::fs::read_to_string(&main).unwrap();
        std::fs::write(&main, &raw[..raw.len() / 2]).unwrap();

        let (s, warn) = load_state_from(&main);
        assert_eq!(s.seq, 1);
        assert_eq!(s.leader.as_deref(), Some("claude"));
        assert!(warn.unwrap().0.contains(".bak"));
        // El roto se aparta, así que la siguiente escritura no copia basura al .bak.
        assert!(!main.exists());
        assert_eq!(corrupt_files(&d).len(), 1);
        write_state_to(&main, &state(3)).unwrap();
        assert_eq!(load_state_from(&main).0.seq, 3);
        assert_eq!(read_state(&backup_path(&main)).unwrap().unwrap().seq, 1);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn both_broken_sets_them_aside_without_losing_them() {
        let d = dir("both");
        let main = d.join("team-state.json");
        let broken_main = r#"{"tasks":[{"id":1,"title":"importante""#;
        std::fs::write(&main, broken_main).unwrap();
        std::fs::write(backup_path(&main), "").unwrap();

        let (s, warn) = load_state_from(&main);
        assert!(s.tasks.is_empty() && s.leader.is_none());
        let (msg, detail) = warn.unwrap();
        assert!(msg.contains("apartado"), "{msg}");
        assert!(detail.contains("corrupt-"), "{detail}");
        assert!(!main.exists() && !backup_path(&main).exists());

        // La siguiente escritura crea un estado nuevo pero no toca lo apartado.
        write_state_to(&main, &state(7)).unwrap();
        let aside = corrupt_files(&d);
        assert_eq!(aside.len(), 2, "{aside:?}");
        let kept = aside.iter().find(|p| !p.to_string_lossy().ends_with(".bak.json")).unwrap();
        assert!(kept.file_name().unwrap().to_string_lossy().starts_with("team-state.corrupt-"));
        assert_eq!(std::fs::read_to_string(kept).unwrap(), broken_main);
        assert_eq!(load_state_from(&main).0.seq, 7);
        let _ = std::fs::remove_dir_all(&d);
    }
}
