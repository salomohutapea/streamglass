"""Rule folders: a tree per kind (breakpoints or scripts). A folder may sit inside another folder of the same kind and
keeps its own enabled and expanded state. Siblings, rules and folders alike, are sorted by an optional numeric `order`,
and the stored rule list is kept in the same top-to-bottom order the tree shows, because rule order decides which
rule applies first."""
import math

KINDS = ("breakpoints", "scripts")
MAX_FOLDERS = 500
MAX_DEPTH = 8
FOLDER_KEYS = {"id", "name", "kind", "parentId", "enabled", "expanded", "order"}


def rule_kind(rule):
    return "scripts" if rule.get("breakpoint") is False else "breakpoints"


def valid_order(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) <= 1e12


def validate_folders(folders):
    """Validates a whole folder list (shape, names unique among siblings, parents of the same kind, no cycles,
    bounded depth) and returns it with names trimmed. Folders written before nesting existed stay valid."""
    if not isinstance(folders, list) or len(folders) > MAX_FOLDERS:
        raise ValueError(f"Expected at most {MAX_FOLDERS} folders")
    by_id = {}
    for item in folders:
        if not isinstance(item, dict) or not {"id", "name", "kind"} <= set(item) or set(item) - FOLDER_KEYS:
            raise ValueError("Expected folder id, name and kind")
        if not isinstance(item["id"], str) or not item["id"] or len(item["id"]) > 256 or item["id"] in by_id:
            raise ValueError("Folder IDs must be unique strings")
        if item["kind"] not in KINDS or not isinstance(item["name"], str) or not item["name"].strip() or len(item["name"].strip()) > 128:
            raise ValueError("Invalid folder name or kind")
        for key in ("enabled", "expanded"):
            if key in item and type(item[key]) is not bool:
                raise ValueError(f"Folder {key} must be boolean")
        if "order" in item and not valid_order(item["order"]):
            raise ValueError("Folder order must be a finite number")
        if "parentId" in item and (not isinstance(item["parentId"], str) or not item["parentId"]):
            raise ValueError("Folder parentId must be a folder id")
        item["name"] = item["name"].strip()
        by_id[item["id"]] = item
    names = set()
    for item in folders:
        parent = item.get("parentId")
        if parent is not None and (parent not in by_id or by_id[parent]["kind"] != item["kind"]):
            raise ValueError("Folder parentId must reference a folder of the same kind")
        depth, cursor = 1, parent
        while cursor is not None:
            depth += 1
            if cursor == item["id"] or depth > MAX_DEPTH:
                raise ValueError(f"Folders cannot contain themselves or nest deeper than {MAX_DEPTH} levels")
            cursor = by_id[cursor].get("parentId")
        key = (item["kind"], parent, item["name"].casefold())
        if key in names:
            raise ValueError("Folder name already exists")
        names.add(key)
    return folders


def descendants(folders, folder_id):
    """Ids of every folder below folder_id."""
    found, frontier = set(), {folder_id}
    while frontier:
        frontier = {item["id"] for item in folders if item.get("parentId") in frontier} - found
        found |= frontier
    return found


def ordered_rules(rules, folders):
    """The rule list in tree order: at every level, rules and folders sorted by `order`, each folder followed by
    its contents. Items without an order keep their stored position (folders first). Rules of the two kinds keep
    the slots their kind occupied, so a breakpoint never trades places with a script."""
    folder_ids = {item["id"] for item in folders}
    flattened = {}
    for kind in KINDS:
        children = {}
        for index, folder in enumerate(folders):
            if folder["kind"] == kind:
                children.setdefault(folder.get("parentId"), []).append((folder["order"] if valid_order(folder.get("order")) else index - MAX_FOLDERS - 1, 0, index, folder))
        for index, rule in enumerate(rules):
            if rule_kind(rule) == kind:
                parent = rule.get("folderId") if rule.get("folderId") in folder_ids else None
                children.setdefault(parent, []).append((rule["order"] if valid_order(rule.get("order")) else index + 1, 1, index, rule))
        output = []

        def walk(parent):
            for _, is_rule, _, item in sorted(children.get(parent, []), key=lambda entry: entry[:3]):
                if is_rule:
                    output.append(item)
                else:
                    walk(item["id"])
        walk(None)
        flattened[kind] = iter(output)
    return [next(flattened[rule_kind(rule)]) for rule in rules]
