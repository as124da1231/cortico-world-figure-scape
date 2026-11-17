extends RefCounted

const TAB := "figure-scape-chat"
var dock: Dock
var send_frame: Callable
var tab_button: Button
var pane: VBoxContainer
var history: VBoxContainer
var scroll: ScrollContainer
var input: LineEdit
var send_button: Button
var status: Label
var summary: Label
var history_key := ""
var draft := ""
var request_id := ""
var awaiting := 0
var next_read := 0
var read_deadline := 0
var phase := "idle"

func attach(target: Dock, transmit: Callable) -> void:
	dock = target
	send_frame = transmit
	pane = VBoxContainer.new()
	pane.name = "FigureScapeConversation"
	pane.size_flags_vertical = Control.SIZE_EXPAND_FILL
	pane.add_theme_constant_override("separation", 8)
	pane.hide()
	dock._top.get_parent().add_child(pane)
	summary = dock._label("正在读取会话…", 12, Hud.INK2)
	pane.add_child(summary)
	scroll = ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.custom_minimum_size.y = 48
	pane.add_child(scroll)
	history = VBoxContainer.new()
	history.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	history.add_theme_constant_override("separation", 6)
	scroll.add_child(history)
	status = dock._label("", 12, Hud.INK2)
	status.hide()
	pane.add_child(status)
	var composer := HBoxContainer.new()
	composer.add_theme_constant_override("separation", 6)
	pane.add_child(composer)
	input = LineEdit.new()
	input.name = "CooMessage"
	input.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	input.placeholder_text = "给 Coo 发消息…"
	input.max_length = 500
	input.custom_minimum_size.y = 36
	input.add_theme_font_override("font", dock._font)
	input.add_theme_font_size_override("font_size", 14)
	input.add_theme_color_override("font_color", Hud.INK)
	input.add_theme_color_override("font_placeholder_color", Hud.INK2)
	input.add_theme_color_override("caret_color", Hud.INK)
	input.add_theme_stylebox_override("normal", dock._box(Hud.PAPER_H, Hud.WOOD_L, 2, 7))
	input.add_theme_stylebox_override("read_only", dock._box(Hud.PAPER, Hud.WOOD_L, 2, 7))
	input.add_theme_stylebox_override("focus", dock._box(Color.TRANSPARENT, Hud.WOOD_D, 2, 7))
	input.text_changed.connect(func(_text: String): _update_composer())
	input.text_submitted.connect(func(_text: String): _submit())
	composer.add_child(input)
	send_button = dock._button("发送", false, _submit, composer)
	send_button.focus_mode = Control.FOCUS_ALL
	_update_composer()

func sync(ready: bool) -> void:
	if not is_instance_valid(dock):
		return
	if not is_instance_valid(tab_button) or tab_button.get_parent() != dock._top:
		tab_button = dock._button("对话", dock.tab == TAB, _open, dock._top)
		tab_button.name = "FigureScapeChatTab"
		tab_button.focus_mode = Control.FOCUS_ALL
	var shown := dock.tab == TAB
	pane.visible = shown
	if not shown:
		return
	dock._scroll.hide()
	var now := Time.get_ticks_msec()
	if awaiting > 0 and now >= awaiting:
		awaiting = 0
		_feedback("发送未确认，输入已保留。")
		_update_composer()
	if not pane.is_visible_in_tree():
		return
	if not ready:
		summary.text = "等待连接 Coo…"
	elif now >= next_read:
		next_read = now + 1200
		if read_deadline == 0:
			read_deadline = now + 4800
		send_frame.call({"type":"chat-read"})
	if read_deadline > 0 and now >= read_deadline:
		summary.text = "会话暂不可用，正在重试。"
	input.editable = ready and awaiting == 0
	_update_composer()

func _open() -> void:
	if dock.tab != TAB:
		dock.tab = TAB
		dock.rebuild()
	pane.show()
	dock._scroll.hide()
	next_read = 0
	input.grab_focus()

func _submit() -> void:
	var text := input.text.strip_edges()
	if text.is_empty() or awaiting > 0 or not input.editable:
		return
	if request_id.is_empty() or text != draft:
		request_id = Crypto.new().generate_random_bytes(16).hex_encode()
		draft = text
	if send_frame.call({"type":"chat-send", "id":request_id, "text":text}) != OK:
		_feedback("暂未连上 Coo，输入已保留。")
		return
	awaiting = Time.get_ticks_msec() + 10000
	_feedback("正在发送…")
	_update_composer()

func receive(frame: Dictionary) -> void:
	match str(frame.get("type", "")):
		"chat-state":
			read_deadline = 0
			phase = str(frame.get("phase", "idle"))
			var messages: Array = frame.get("messages", [])
			summary.text = ("和 Coo 开始对话" if messages.is_empty() else "与 Coo 的会话") if phase == "idle" else "Coo 正在处理…"
			var key := JSON.stringify(messages)
			if key != history_key:
				history_key = key
				_show_messages(messages)
		"chat-result":
			if str(frame.get("id", "")) != request_id:
				return
			awaiting = 0
			if frame.get("ok") == true:
				if input.text.strip_edges() == draft:
					input.clear()
				draft = ""
				request_id = ""
				next_read = 0
				_feedback("")
			else:
				_feedback(str(frame.get("error", "发送失败，输入已保留。")))
			_update_composer()

func _feedback(message: String) -> void:
	status.text = message
	status.visible = not message.is_empty()

func _update_composer() -> void:
	send_button.disabled = not input.editable or awaiting > 0 or input.text.strip_edges().is_empty()

func _show_messages(messages: Array) -> void:
	var scrollbar := scroll.get_v_scroll_bar()
	var near_end := scrollbar.value + scrollbar.page + 24.0 >= scrollbar.max_value
	for child in history.get_children():
		history.remove_child(child)
		child.queue_free()
	for message: Dictionary in messages:
		var bubble := PanelContainer.new()
		var mine: bool = message.get("side") == "user"
		bubble.size_flags_horizontal = Control.SIZE_SHRINK_END if mine else Control.SIZE_SHRINK_BEGIN
		bubble.custom_minimum_size.x = maxf(92, scroll.size.x * 0.72)
		bubble.add_theme_stylebox_override("panel", dock._box(Hud.PAPER_D if mine else Hud.PAPER_H, Hud.WOOD_L if mine else Hud.PAPER_D, 1, 7))
		var label := dock._label(str(message.get("text", "")), 14)
		bubble.add_child(label)
		history.add_child(bubble)
	if near_end:
		_scroll_to_latest.call_deferred()

func _scroll_to_latest() -> void:
	await pane.get_tree().process_frame
	if is_instance_valid(scroll):
		scroll.scroll_vertical = int(scroll.get_v_scroll_bar().max_value)
