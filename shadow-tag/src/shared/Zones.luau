--!strict
-- Power zones of the station. The rectangles must match the rooms that
-- MapBuilder creates; both server (speed bonus, outages) and client
-- (ambient darkness, HUD) resolve "which zone am I in" through Zones.at().

export type Rect = { x1: number, x2: number, z1: number, z2: number, y1: number, y2: number }
export type Zone = { id: string, name: string, rects: { Rect } }

local function rect(x1: number, x2: number, z1: number, z2: number, y1: number?, y2: number?): Rect
	return { x1 = x1, x2 = x2, z1 = z1, z2 = z2, y1 = y1 or -2, y2 = y2 or 22 }
end

local Zones = {}

Zones.List = {
	{
		id = "Platform",
		name = "Central Platform",
		rects = { rect(-120, 120, -28, 60, -8, 22) },
	},
	{
		id = "Concourse",
		name = "Ticket Concourse",
		rects = { rect(-70, 30, 60, 140) },
	},
	{
		id = "Stairwell",
		name = "Stairwell & Street Exit",
		rects = { rect(-64, -6, 140, 220, -2, 60), rect(-80, 10, 220, 270, 36, 60) },
	},
	{
		id = "Maintenance",
		name = "Maintenance",
		rects = { rect(50, 130, 70, 140), rect(30, 50, 100, 114), rect(88, 102, 60, 70) },
	},
	{
		id = "WestTunnel",
		name = "West Tunnel",
		rects = { rect(-340, -120, 18, 38), rect(-340, -320, 38, 130), rect(-320, -70, 110, 130) },
	},
	{
		id = "EastTunnel",
		name = "East Tunnel",
		rects = { rect(120, 340, 18, 38), rect(320, 340, 38, 130), rect(130, 320, 110, 130) },
	},
} :: { Zone }

Zones.ById = {} :: { [string]: Zone }
for _, zone in Zones.List do
	Zones.ById[zone.id] = zone
end

function Zones.at(position: Vector3): string?
	for _, zone in Zones.List do
		for _, r in zone.rects do
			if position.X >= r.x1 and position.X <= r.x2 and position.Z >= r.z1 and position.Z <= r.z2 and position.Y >= r.y1 and position.Y <= r.y2 then
				return zone.id
			end
		end
	end
	return nil
end

return Zones
