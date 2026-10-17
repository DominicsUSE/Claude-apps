--!strict
-- Every tunable number for Shadow Tag: Lights Out lives here so balancing
-- never requires touching gameplay code. Shared by server and client.

local Config = {}

-- Players / round flow -------------------------------------------------------
Config.MinPlayersForPvP = 2 -- below this, an AI Shadow hunts the lone player
Config.LobbyTime = 15
Config.HidingTime = 10
Config.RoundTime = 240
Config.ResultsTime = 10
Config.TrainDoorsOpenAt = 90 -- seconds remaining when the last train opens its doors
Config.FinalWarningAt = 45 -- seconds remaining for the "final call" warning
Config.TransformTime = 2 -- tagged survivor -> Shadow transformation

-- Movement (studs / second) --------------------------------------------------
Config.WalkSpeed = 12
Config.SprintSpeed = 20
Config.CrouchSpeed = 6
Config.LobbyWalkSpeed = 14
Config.ShadowDarkBonus = 1.15 -- Shadows move 15% faster inside unpowered zones
Config.GlowstickShadowSlow = 0.6 -- Shadow speed multiplier inside a glowstick's light

-- Stamina ---------------------------------------------------------------------
Config.StaminaMax = 100
Config.StaminaDrain = 22 -- per second while sprinting
Config.StaminaRegenWalking = 12
Config.StaminaRegenIdle = 20
Config.StaminaRegenDelay = 0.8 -- pause after sprinting stops before regen starts
Config.StaminaMinToSprint = 12

-- Flashlight ------------------------------------------------------------------
Config.BatteryMax = 100
Config.BatteryDrain = 1.1 -- per second while on (~90 s of continuous light)
Config.BatteryRecharge = 0.6 -- per second while off
Config.BatteryMinToTurnOn = 5
Config.BatteryFlickerBelow = 15
Config.FlashlightRange = 46
Config.FlashlightAngle = 52
Config.FlashlightBrightness = 3.2
Config.ShadowSeesFlashlightsWithin = 90 -- Shadows get a faint marker on lit survivors

-- Glowsticks ------------------------------------------------------------------
Config.GlowsticksStart = 2
Config.GlowsticksMax = 4
Config.GlowstickLifetime = 15
Config.GlowstickSafeRadius = 11
Config.GlowstickCooldown = 1.0
Config.GlowstickThrowSpeed = 42
Config.GlowstickPickupRespawn = 45

-- Tagging ---------------------------------------------------------------------
Config.TagRange = 5
Config.TagVerticalRange = 5
Config.NewShadowTagDelay = 1.5 -- grace after a Shadow finishes transforming

-- Lighting / power --------------------------------------------------------------
Config.OutageInterval = 30
Config.BreakerRestoreTime = 20
Config.BreakerCooldown = 8 -- extra lockout after a restore expires
Config.BreakerHoldTime = 1.2
Config.BreakerNoiseRadius = 14 -- jitter applied to the location revealed to Shadows
Config.NoisePingDuration = 4

-- Detection / audio -----------------------------------------------------------
Config.HeartbeatRange = 55
Config.SprintNoiseRange = 60 -- how far the AI Shadow "hears" sprinting

-- Anti-exploit ----------------------------------------------------------------
Config.SpeedCheckInterval = 0.5
Config.SpeedTolerance = 1.6 -- multiplier over the allowed speed
Config.SpeedSlack = 6 -- extra studs allowed per check window (lag, jumps)
Config.RemoteRateLimit = 12 -- max remote calls per second per player per remote

return Config
