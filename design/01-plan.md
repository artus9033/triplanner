The purpose of this project is a trip planner web app (React web) & backend (NodeJS), gui with MUI, state with zustand, routing with react-router.

We should be able to run this all in dev mode with autorestart of backend + frontend. Use MongoDB for DB. Always write in typescript, use prettier + lefthook and commitlint.

0. The user is presented a minimal nice (non resembling any existing) web chat UI with slogan "Where do you want to travel?" / "When do you want to travel?" / "Quo vadis?" that is cycling with a nice delicate animation.

The user can chat about their trip, they first start with a guided state machine tour that wants to collect some information about the trip: when (date ranges), city, what plans they have, the $ budget they have (optional, if they have no limits, fill in `null`). The plans can be less or more specific, like "I want to visit a museum" or "I want to visit a museum and a restaurant", or "I want to visit modern art museums", or "I want to visit the Louvre - specifically the Richelieu wing - and then some nice modern art galleries", and so on.
If they lack some information, the state machine will ask them for it. Do not overstate and build a sensible prompt, use langchain and a state machine with chat history + structured state filling + allow user to have different trips (conversations like).

Integrate a small whisper OSS model for speech to text + a small model text to speech with a nice voice for user to be able to type with voice + read aloud the messages from AI.

Of all steps, a MUI https://mui.com/material-ui/react-timeline/ somewhere you suggest should show the steps of planning this trip (all steps in hte plan) with help tooltips wehn you hover.

1. First step after completion - refinement of the trip plan with the user based on the chat history and the state machine. If the user was not specific about the place, a spacexai grok LLM over the API with web search tool (NO OTHER TOOLS ALLOWED) should search and propose the places, then the user should be shown a multiselect component with places + 1 link per place to google maps / website if not on google maps. The user should be able to select the places and the state machine should update the trip plan with the selected places.

If the user was specific about the places and there is no need for search, this step should skip.

2. We spawn predefined number of bots (say in a config constants file, default up to 5) and those bots take the stuff from the trip plan and each uses spacexai grok LLM over the API with ONLY web search tool to search on place's website and collect the information about the place. The information should be extracted to structured data ONLY pertaining to the possible dates when the user is travelling:

```json
{
  "place": "name of the place",
  "address": "address of the place",
  "phone": "phone number of the place",
  "website": "website of the place",
  "hours": [
    {
      "date": "YYYY-MM-DD",
      "start": "HH:MM",
      "end": "HH:MM"
    }
  ],
  "description": "description of the place in max 120 characters",
  "google_place_id": "google place id of the place",
  "google_maps_url": "google maps url of the place",
  "place_image_url": "image url of the place",
  "tickets": {
    {
        "type": "free" | "paid" | "reduced",
        "price": "price of the ticket in the currency of the place, including the currency e.g. 20USD",
        "condition": null | "null if free or condition in few words e.g. 'under 18 free', or 'on tuesday it is free', or 'under 25 reduced'"
    }
  },
  "needs_reservation": true
}
```

These bots drain all places to be visited one by one and collect the information about the place. The information is stored in a database. The prompt should say the time budget for each agent is tops 1 minute.

3. At this step, the structured data above should be presented to user visually + sidebar with map and loose points with tooltips hover + info should pop on hover.

4. In the meantime, optimization of trip schedule: using the structured data, we should launch ampl ; this step houses no 3 in the steps timeline from beginning of this plan.

Use plan from 02-optimization-design-out.md as guide to how the optimization should be done.
