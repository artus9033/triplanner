The purpose of this project is a trip planner web app (React web) & backend (NodeJS), gui with MUI, state with zustand, routing with react-router.

0. The user is presented a minimal nice (non resembling any existing) web chat UI with slogan "Where do you want to travel?" / "When do you want to travel?" / "Quo vadis?" that is cycling with a nice delicate animation.

The user can chat about their trip, they first start with a guided state machine tour that wants to collect some information about the trip: when (date ranges), city, what plans they have. The plans can be less or more specific, like "I want to visit a museum" or "I want to visit a museum and a restaurant", or "I want to visit modern art museums", or "I want to visit the Louvre - specifically the Richelieu wing - and then some nice modern art galleries", and so on.
If they lack some information, the state machine will ask them for it. Do not overstate and build a sensible prompt, use langchain and a state machine with chat history + structured state filling + allow user to have different trips (conversations like).

Integrate a small whisper OSS model for speech to text + a small model text to speech with a nice voice for user to be able to type with voice + read aloud the messages from AI.

1. First step after completion - refinement
