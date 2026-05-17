use knock_core::openapi::parse_spec;

#[test]
fn petstore3_parses_with_refs_and_responses() {
    let bytes = include_bytes!("petstore3.json");
    let spec = parse_spec(bytes).expect("parse");
    assert!(spec.operations.len() > 10, "should find many ops");

    let add_pet = spec
        .operations
        .iter()
        .find(|op| op.operation_id == "addPet")
        .expect("addPet exists");
    let body = add_pet
        .body_json
        .as_ref()
        .expect("addPet has json body schema");
    // Pet schema resolved via $ref → properties present
    assert!(body.get("name").is_some(), "Pet.name resolved");
    assert!(body.get("photoUrls").is_some(), "Pet.photoUrls resolved");
    // Nested ref: tags -> [Tag]
    let tags = body
        .get("tags")
        .and_then(|v| v.as_array())
        .expect("tags array");
    assert_eq!(tags.len(), 1);
    assert!(tags[0].is_object(), "Tag schema resolved");

    let get_by_id = spec
        .operations
        .iter()
        .find(|op| op.operation_id == "getPetById")
        .expect("getPetById exists");
    assert!(
        get_by_id.path_params.contains_key("petId"),
        "path param petId captured"
    );
    let r200 = get_by_id
        .responses
        .get("200")
        .expect("getPetById has 200");
    assert!(r200.example.is_some(), "200 example resolved from schema");
}
