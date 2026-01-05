import { config } from "@elgato/eslint-config";

export default [
	{
		ignores: ["se.oscarb.pomodoro.sdPlugin/**", "dist/**", "bin/**", "node_modules/**"]
	},
	...config.recommended,
	{
		rules: {
			"jsdoc/require-jsdoc": "off"
		}
	}
];