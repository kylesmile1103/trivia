use trivia_expr::{AnalyzeRequest, Severity, analyze};

#[test]
fn fr_ex_05_reports_closed_paths_only_on_participating_expressions() {
    let request: AnalyzeRequest = serde_json::from_str(r#"{
      "scope":{"roots":{
        "data":{"tier":"query","members":null},
        "state":{"tier":"client","members":null},
        "ui":{"tier":"client","members":null}
      }},
      "expressions":[
        {"id":"two", "defines":"data.b", "source":"data.a.total"},
        {"id":"one", "defines":"data.a", "source":"data.b.total"},
        {"id":"independent-param", "defines":"data.b", "source":"10"},
        {"id":"unrelated-consumer", "source":"data.a.total"},
        {"id":"direct", "defines":"state.self", "source":"state.self"},
        {"id":"first", "defines":"data.chain", "source":"ui.lookup.value"},
        {"id":"second", "defines":"ui.lookup", "source":"state.key"},
        {"id":"third", "defines":"state.key", "source":"data.chain.item"},
        {"id":"unrelated-edge", "defines":"state.key", "source":"state.leaf"},
        {"id":"wildcard", "defines":"ui.wildcard", "source":"ui['x' + 'y']"}
      ]
    }"#).unwrap();
    let results = analyze(request).results;
    let expected = [
        Some("data.a -> data.b -> data.a"), Some("data.a -> data.b -> data.a"), None, None,
        Some("state.self -> state.self"), Some("data.chain -> ui.lookup -> state.key -> data.chain"),
        Some("data.chain -> ui.lookup -> state.key -> data.chain"),
        Some("data.chain -> ui.lookup -> state.key -> data.chain"), None,
        Some("ui.* -> ui.wildcard -> ui.*"),
    ];
    for (result, path) in results.iter().zip(expected) {
        if let Some(path) = path {
            assert!(!result.ok, "{}", result.id);
            let [diagnostic] = result.diagnostics.as_slice() else { panic!("{result:?}") };
            assert_eq!((diagnostic.code, diagnostic.severity), ("expr_cycle", Severity::Error));
            assert!(diagnostic.message.contains(path), "{}: {}", result.id, diagnostic.message);
        } else {
            assert!(result.ok && result.diagnostics.is_empty(), "{result:?}");
        }
    }
}

#[test]
fn fr_ex_05_overlapping_cycles_include_all_members_in_a_closed_walk() {
    let request: AnalyzeRequest = serde_json::from_str(r#"{
      "scope":{"roots":{"data":{"tier":"query","members":null}}},
      "expressions":[
        {"id":"ab", "defines":"data.a", "source":"data.b.total"},
        {"id":"ac", "defines":"data.a", "source":"data.c.total"},
        {"id":"ba", "defines":"data.b", "source":"data.a.total"},
        {"id":"ca", "defines":"data.c", "source":"data.a.total"}
      ]
    }"#).unwrap();
    for result in analyze(request).results {
        let [diagnostic] = result.diagnostics.as_slice() else { panic!("{result:?}") };
        assert_eq!(diagnostic.code, "expr_cycle");
        assert!(diagnostic.message.contains("data.a -> data.b -> data.a -> data.c -> data.a"));
    }
}
