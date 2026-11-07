--[[
	ChadConfig (ModuleScript in ReplicatedStorage)

	Gameplay tunables shared by the client animator and the server.
	Animation style numbers (stride, lean, arm swing...) live in
	ChadAnimate > Gait > STYLE.
]]

return {
	-- Movement
	WALK_SPEED = 12, -- Roblox default is 16, which reads as a jog on R15 legs
	RUN_SPEED = 24,
	SPEED_CHANGE_RATE = 6, -- how quickly WalkSpeed eases between walk and run
	TOUCH_RUN_BUTTON = true, -- show a RUN button on phones and tablets

	-- Animation
	FOOT_IK = true, -- raycast each foot onto stairs and slopes
	LOOK_AT_CAMERA = true, -- your own head turns toward where the camera looks
	ANIMATE_DISTANCE = 300, -- characters farther from the camera stay at rest
	FOOT_IK_DISTANCE = 120, -- beyond this, feet assume flat ground (fewer raycasts)

	-- Any model with a Humanoid and this CollectionService tag is animated
	-- too (the world's NPCs use it).
	NPC_TAG = "ChadAnimate",
}
