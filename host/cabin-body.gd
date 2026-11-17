extends Node

var actor_key := ""
var socket := WebSocketPeer.new()
var texture: ImageTexture
var anchor := Vector2.ZERO
var scale_factor := 1.0
var confirmed := false
var frame_drawn := false
var awaiting_draw := false
var position_requested := false
var staged := false
var revealed := false
var restored_mode := Window.MODE_WINDOWED
var actor: Character
var portrait: Image
var portrait_cache := ""
var portrait_source := ""
var cached_portraits := {}
var residents_to_check := -1
var chat
var chat_loaded := false
var resident_button: Button
var resident_manager: AcceptDialog
var dock_residents_ready := false
var arcade_updated := 0
var arcade_rows: Array = []
const ARCADE_SEATS := {"arcade_blocks":"blocks","arcade_blocks_2":"blocks","arcade_snake":"snake","arcade_mines":"mines","arcade_xiangqi":"xiangqi","arcade_gomoku":"gomoku"}

func _ready() -> void:
	actor_key = OS.get_environment("FIGURE_SCAPE_CABIN_ACTOR")
	portrait_cache = OS.get_environment("FIGURE_SCAPE_CABIN_PORTRAITS")
	portrait_source = OS.get_environment("FIGURE_SCAPE_CABIN_PORTRAIT_SOURCE")
	var url := OS.get_environment("FIGURE_SCAPE_CABIN_BODY")
	if actor_key.is_empty() or not url.begins_with("ws://127.0.0.1:"):
		set_process(false)
		return
	process_priority = 1000
	DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_NO_FOCUS, true)
	socket.inbound_buffer_size = 1024 * 1024
	if socket.connect_to_url(url) != OK:
		set_process(false)

func _process(_delta: float) -> void:
	if not staged and not revealed and get_tree().current_scene != null:
		staged = true
		var window := get_window()
		restored_mode = window.mode
		if window.mode != Window.MODE_WINDOWED:
			window.mode = Window.MODE_WINDOWED
		window.position = Vector2i(-16000, -16000)
	socket.poll()
	var connected := socket.get_ready_state() == WebSocketPeer.STATE_OPEN
	_sync_sidebar(connected)
	if not connected:
		return
	var packet := PackedByteArray()
	while socket.get_available_packet_count() > 0:
		var data := socket.get_packet()
		if not socket.was_string_packet():
			packet = data
			continue
		var message := data.get_string_from_utf8()
		match message:
			"report-position": position_requested = true
			"reveal": _reveal()
			_:
				if chat != null and message.begins_with("{"):
					var frame: Variant = JSON.parse_string(message)
					if frame is Dictionary:
						chat.receive(frame)
	if not packet.is_empty():
		_update_texture(packet)
	if not is_instance_valid(actor):
		_find_actor()
	_restore_portraits()
	if texture == null or not is_instance_valid(actor) or not actor.placed:
		return
	if portrait != null:
		_apply_portrait(actor, portrait)
		if not portrait_cache.is_empty():
			portrait.save_png(portrait_cache.path_join(actor_key + ".png"))
		portrait = null
	if position_requested and VadsLink.connected:
		actor.report_position()
		position_requested = socket.send_text("position-reported") != OK
	var shift := Vector2(0.0, actor._display.y - actor.position.y)
	actor._body_sprite(texture, Rect2(Vector2.ZERO, texture.get_size()), anchor, scale_factor, shift, 0.0)
	actor._upper.visible = false
	if frame_drawn and not confirmed:
		confirmed = socket.send_text("ready") == OK
	elif not frame_drawn and not awaiting_draw and actor.is_visible_in_tree() and actor._sprite.visible:
		awaiting_draw = true
		RenderingServer.frame_post_draw.connect(_confirm, CONNECT_ONE_SHOT)

func _confirm() -> void:
	frame_drawn = true
	awaiting_draw = false

func _reveal() -> void:
	if not staged:
		return
	if revealed:
		socket.send_text("presented")
		return
	revealed = true
	var window := get_window()
	window.always_on_top = false
	var screen := DisplayServer.screen_get_usable_rect(DisplayServer.SCREEN_PRIMARY)
	window.position = screen.position + (screen.size - window.size) / 2
	DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_NO_FOCUS, false)
	window.mode = restored_mode
	socket.send_text("presented")

func _find_actor() -> void:
	var world = get_tree().current_scene
	if world == null:
		return
	for index in range(world.characters.size()):
		var resident: Character = world.characters[index]
		if resident.key == actor_key and resident.placed:
			actor = resident
			if world.follow != index:
				world._on_follow_picked(index)
			break

func _send_chat(frame: Dictionary) -> Error:
	if not revealed or socket.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return ERR_CONNECTION_ERROR
	return socket.send_text(JSON.stringify(frame))

func _sync_sidebar(connected: bool) -> void:
	var world = get_tree().current_scene
	if world == null:
		return
	var dock = world.get("_dock")
	if not is_instance_valid(dock):
		return
	if not chat_loaded:
		chat_loaded = true
		if is_instance_valid(dock.get("_top")) and is_instance_valid(dock.get("_scroll")) and dock.has_method("_button"):
			var script := load(OS.get_environment("FIGURE_SCAPE_CABIN_CHAT")) as GDScript
			if script != null and script.can_instantiate():
				chat = script.new()
				chat.attach(dock, _send_chat)
	if chat != null:
		chat.sync(connected and revealed)
	if is_instance_valid(actor):
		_sync_resident_controls(dock)
		_layout_sidebar(world, dock, world.characters.find(actor))

func _sync_resident_controls(dock) -> void:
	var top = dock.get("_top")
	if not is_instance_valid(top) or not dock.has_method("_button"):
		return
	if not dock_residents_ready:
		dock_residents_ready = true
		WorldData.resident_registered.connect(func(_key): _refresh_residents.call_deferred(dock))
		WorldData.resident_named.connect(func(_key): _refresh_residents.call_deferred(dock))
		WorldData.resident_removed.connect(func(_key, _scene): _refresh_residents.call_deferred(dock))
		_refresh_residents(dock, true)
	if not is_instance_valid(resident_button) or resident_button.get_parent() != top:
		resident_button = dock._button("住户", false, _open_resident_manager, top)
		resident_button.name = "FigureScapeResidents"
		resident_button.tooltip_text = "管理住户名称和房间"
		resident_button.focus_mode = Control.FOCUS_ALL

func _refresh_residents(dock, select_current := false) -> void:
	if not is_instance_valid(dock) or not dock.get("RESIDENTS") is Array:
		return
	var personal = load("res://core/resident_personal.gd")
	var rows: Array = Residents.people().map(func(person): return [person.key, personal.label(person.key, person.name)])
	var counts := {}
	for row in rows:
		counts[row[1]] = counts.get(row[1], 0) + 1
	for row in rows:
		if counts[row[1]] > 1:
			row[1] += "（当前）" if row[0] == actor_key else " · " + str(row[0]).right(4)
	var keys: Array = rows.map(func(row): return row[0])
	if not keys.has(actor_key):
		return
	dock.set("RESIDENTS", rows)
	for field in ["_log_who", "_diary_who", "_who"]:
		if select_current or not keys.has(dock.get(field)):
			dock.set(field, actor_key)
	dock.rebuild()

func _open_resident_manager() -> void:
	if is_instance_valid(resident_manager):
		resident_manager.popup_centered()
		return
	var script := load("res://ui/resident_manager.gd") as GDScript
	if script == null or not script.can_instantiate():
		return
	resident_manager = script.new()
	var manager = resident_manager
	add_child(manager)
	var keys = manager.get("keys")
	var people = manager.get("people")
	if keys is Array and people is OptionButton:
		var index: int = keys.find(actor_key)
		if index >= 0:
			people.select(index)
			var profile: Dictionary = load("res://core/resident_registry.gd").describe(actor_key)
			var name_field = manager.get("name_field")
			var home_field = manager.get("home_field")
			if name_field is LineEdit and home_field is LineEdit:
				name_field.text = str(profile.get("name", ""))
				home_field.text = str(profile.get("homeName", ""))

func _layout_sidebar(world, dock, index: int) -> void:
	var hud: Hud = world.get("_hud")
	if not is_instance_valid(hud):
		return
	var cards: Array[Rect2] = hud.card_rects
	if index < 0 or cards.size() < 2:
		return
	var first := cards[0]
	var last := cards[index] if index >= 2 and index < cards.size() else cards[1]
	var stacked := last.position.y > first.position.y
	var rail := Rect2(Vector2(first.position.x, last.position.y), Vector2(last.size.x if stacked else last.end.x - first.position.x, last.size.y))
	var start := last.end.y + 6.0
	var bottom: float = world.size.y - hud.grass_height - 6.0
	if index >= 2:
		if cards.size() == 2:
			# The native HUD indexes its rectangles by resident index.
			var hidden := Rect2(Vector2(-last.size.x - 40, -last.size.y - 40), last.size)
			cards[1] = hidden
			while cards.size() < index:
				cards.append(hidden)
			cards.append(last)
			hud.card_rects = cards
			hud.queue_redraw()
	var arcade = world.get("_arcade")
	if is_instance_valid(arcade) and arcade.has_method("_refresh_card") and arcade.has_method("live_choices") and arcade.get("_cards") is Array:
		var dock_min := 176.0 if dock.get("tab") == "figure-scape-chat" else 120.0
		start = _layout_arcade(arcade, world, rail, start, bottom, dock_min)
	dock.visible = bottom - start >= 120.0
	dock.position = Vector2(rail.position.x, start)
	dock.size = Vector2(rail.size.x, maxf(0.0, bottom - start))

func _layout_arcade(arcade, world, last: Rect2, start: float, bottom: float, dock_min: float) -> float:
	var now := Time.get_ticks_msec()
	var refresh := now >= arcade_updated
	var in_arcade: bool = world.view_scene == "world-arcade"
	if refresh:
		arcade_updated = now + 150
		var seat: String = ARCADE_SEATS.get(actor.want_zone, "") if actor.scene_id == "world-arcade" else ""
		arcade_rows = _table_rows(arcade, arcade.selected, in_arcade, seat)
	var available: float = bottom - start - dock_min - 6.0
	var show_arcade: bool = (in_arcade or not arcade_rows.is_empty() or world._arcade_show) and available >= 120.0
	arcade.set_process(false)
	arcade.visible = show_arcade
	if show_arcade:
		var height := minf(available, floorf((bottom - start - 6.0) / 2.0))
		if not arcade_rows.any(func(row): return row.get("game") is Dictionary) and not world._arcade_show:
			height = minf(height, 154.0)
		arcade.position = Vector2(last.position.x, start)
		arcade.size = Vector2(last.size.x, height)
		start += arcade.size.y + 6.0
		if refresh:
			_draw_arcade(arcade)
	return start

func _table_rows(arcade, selection: String, retain_result: bool, seat := "") -> Array:
	var view := VadsLink.arcade_view
	var sessions: Dictionary = view.get("sessions", {})
	var own := {}
	var latest := -1.0
	var history_kind := selection if selection != "" else seat
	for cabinet: String in sessions:
		var row: Dictionary = sessions[cabinet]
		if selection != "" and selection != row.get("kind"):
			continue
		if not row.get("players", []).any(func(player): return player.get("id") == actor_key):
			continue
		if row.get("status") in ["waiting", "playing"]:
			own = row.merged({"cabinetKey":cabinet}, true)
			break
		var at := float(row.get("endedAt", 0))
		if retain_result and at > latest and (history_kind == "" or row.get("kind") == history_kind):
			own = row
			latest = at
	if retain_result and own.is_empty():
		var history: Array = view.get("history", [])
		for i in range(history.size() - 1, -1, -1):
			var entry: Dictionary = history[i]
			var players: Array = entry.get("players", [])
			var member = players.filter(func(player): return player.get("id") == actor_key)
			if not member.is_empty() and (history_kind == "" or history_kind == entry.get("kind")):
				own = entry.merged({"status":member[0].get("result", ""), "cabinetKey":"", "endedAt":entry.get("at")})
				break
	var rows: Array = arcade.call("live_choices", sessions, selection)
	if not own.is_empty():
		if own.get("status") in ["waiting", "playing"] or rows.is_empty():
			rows = rows.filter(func(row): return row.get("matchId") != own.get("matchId"))
			rows.push_front(own)
	return rows.slice(0, 2)

func _draw_arcade(panel) -> void:
	var live := arcade_rows.any(func(row): return row.get("status") in ["waiting", "playing"])
	var title: Label = panel.get_child(0).get_child(0)
	if arcade_rows.is_empty():
		title.text = "星光电玩城 · 暂无对局"
	else:
		title.text = "星光电玩城 · 实时对局" if live else "星光电玩城 · 最近对局"
	var picker = panel.get("_select")
	if picker is OptionButton and picker.item_count > 0:
		picker.set_item_text(0, "自动：优先当前对局")
	for i in panel._cards.size():
		var card: Dictionary = panel._cards[i]
		card.card.visible = i < arcade_rows.size()
		if not card.card.visible:
			continue
		panel._who = card.who
		panel._state = card.state
		panel._board = card.board
		panel._detail = card.detail
		var row: Dictionary = arcade_rows[i]
		panel._refresh_card(row)
		if row.get("status") == "waiting" and row.get("players", []).any(func(player): return player.get("id") == actor_key):
			panel._state.text = "正在前往机台" if actor.is_walking() else "等待开局"
		if not row.get("game") is Dictionary:
			panel._board.hide()
		else:
			panel._board.show()

func _update_texture(data: PackedByteArray) -> void:
	var image := Image.new()
	if image.load_png_from_buffer(data) != OK:
		return
	image.convert(Image.FORMAT_RGBA8)
	if texture != null:
		if texture.get_size() == Vector2(image.get_size()):
			texture.update(image)
		return
	var bounds := _body_bounds(image)
	if bounds.size.y < 30 or bounds.size.y >= image.get_height() or image.get_pixel(0, 0).a > 0.01:
		return
	anchor = Vector2(bounds.position.x + float(bounds.size.x) / 2.0, bounds.end.y)
	scale_factor = 84.0 / float(bounds.size.y)
	texture = ImageTexture.create_from_image(image)
	if not portrait_source.is_empty():
		var cover := Image.load_from_file(portrait_source)
		if cover != null and not cover.is_empty():
			if maxi(cover.get_width(), cover.get_height()) > 512:
				var cover_scale := 512.0 / float(maxi(cover.get_width(), cover.get_height()))
				cover.resize(maxi(1, roundi(cover.get_width() * cover_scale)), maxi(1, roundi(cover.get_height() * cover_scale)), Image.INTERPOLATE_LANCZOS)
			cover.convert(Image.FORMAT_RGBA8)
			var cover_bounds := _body_bounds(cover)
			if cover_bounds.has_area() and cover.get_pixel(0, 0).a < 0.01:
				image = cover
				bounds = cover_bounds
	# Match the square already used by the resident card and map tabs.
	var crop_height := maxi(1, roundi(float(bounds.size.y) * 0.60))
	var upper := image.get_region(Rect2i(bounds.position, Vector2i(bounds.size.x, crop_height)))
	var subject := _body_bounds(upper)
	if subject.has_area():
		var cropped := upper.get_region(subject)
		var factor := 172.0 / float(maxi(cropped.get_width(), cropped.get_height()))
		var fit := Vector2i(maxi(1, roundi(cropped.get_width() * factor)), maxi(1, roundi(cropped.get_height() * factor)))
		cropped.resize(fit.x, fit.y, Image.INTERPOLATE_LANCZOS)
		portrait = Image.create(185, 185, false, Image.FORMAT_RGBA8)
		var offset := Vector2i((185 - fit.x) / 2, 185 - fit.y)
		portrait.blit_rect(cropped, Rect2i(Vector2i.ZERO, fit), offset)

# Bound the body without using faint shadows or a separated expression as its anchor.
func _body_bounds(image: Image) -> Rect2i:
	var data := image.get_data()
	var width := image.get_width()
	var band := Rect2i()
	var active := Rect2i()
	var weight := 0
	var strongest := 0
	var blank_rows := 0
	for y in range(image.get_height()):
		var left := width
		var right := -1
		for x in range(width):
			if data[(y * width + x) * 4 + 3] < 128:
				continue
			left = mini(left, x)
			right = x
			weight += 1
		if right >= left:
			var row := Rect2i(left, y, right - left + 1, 1)
			active = active.merge(row) if active.has_area() else row
			blank_rows = 0
		else:
			blank_rows += 1
			if blank_rows >= 3:
				active = Rect2i()
				weight = 0
		if weight > strongest:
			strongest = weight
			band = active
	return band

func _restore_portraits() -> void:
	var world = get_tree().current_scene
	if portrait_cache.is_empty() or world == null or residents_to_check == world.characters.size():
		return
	residents_to_check = world.characters.size()
	for resident: Character in world.characters:
		var key: String = resident.key
		if key == actor_key or not key.begins_with("figure-scape-") or not key.is_valid_filename():
			continue
		if cached_portraits.get(key) == resident.get_instance_id():
			continue
		var file := portrait_cache.path_join(key + ".png")
		if FileAccess.file_exists(file):
			var cached := Image.load_from_file(file)
			if cached != null and cached.get_size() == Vector2i(185, 185):
				cached.convert(Image.FORMAT_RGBA8)
				_apply_portrait(resident, cached)
		cached_portraits[key] = resident.get_instance_id()

func _apply_portrait(resident: Character, picture: Image) -> void:
	var atlas := resident._walk_tex.get_image()
	var first: Array = resident._walk["rects"][0]
	var base: Array = resident._walk["anchors"][0]
	var area := Rect2i(roundi(first[0] + base[0] - 92.5), roundi(first[1] + base[1] - 278.0), 185, 185)
	if atlas == null or not Rect2i(Vector2i.ZERO, atlas.get_size()).encloses(area):
		return
	atlas.convert(Image.FORMAT_RGBA8)
	atlas.blit_rect(picture, Rect2i(Vector2i.ZERO, picture.get_size()), area.position)
	resident._walk_tex = ImageTexture.create_from_image(atlas)
	get_tree().current_scene._hud.queue_redraw()
