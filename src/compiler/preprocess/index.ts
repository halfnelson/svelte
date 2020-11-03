import { RawSourceMap, DecodedSourceMap } from '@ampproject/remapping/dist/types/types';
import { getLocator } from 'locate-character';
import { StringWithSourcemap, combine_sourcemaps } from '../utils/string_with_sourcemap';

export interface Processed {
	code: string;
	map?: string | object;  // we are opaque with the type here to avoid dependency on the remapping module for our public types.
	dependencies?: string[];
}

export interface PreprocessorGroup {
	markup?: (options: {
		content: string;
		filename: string;
	}) => Processed | Promise<Processed>;
	style?: Preprocessor;
	script?: Preprocessor;
}

export type Preprocessor = (options: {
	content: string;
	attributes: Record<string, string | boolean>;
	filename?: string;
}) => Processed | Promise<Processed>;

function parse_attributes(str: string) {
	const attrs = {};
	str.split(/\s+/).filter(Boolean).forEach(attr => {
		const p = attr.indexOf('=');
		if (p === -1) {
			attrs[attr] = true;
		} else {
			attrs[attr.slice(0, p)] = '\'"'.includes(attr[p + 1]) ?
				attr.slice(p + 2, -1) :
				attr.slice(p + 1);
		}
	});
	return attrs;
}

class PreprocessorTarget {
	filename: string
	source: string
	dependencies: Set<string> = new Set([]);
	sourcemap_list: Array<DecodedSourceMap | RawSourceMap> = [];
	was_processed = false;

	constructor(content: string, filename: string) {
		this.filename = filename;
		this.source = content;
	}

	applyPreprocessorOutput(processed: Processed) {
		if (processed) {
			this.was_processed = true;
			this.source = processed.code;
			if (processed.dependencies) processed.dependencies.map(v => this.dependencies.add(v));
			if (processed.map) {
				this.sourcemap_list.unshift(
					typeof (processed.map) === 'string'
						? JSON.parse(processed.map)
						: processed.map
				);
			}
		}
	}

	getCombinedSourceMap() {
		if (this.sourcemap_list.length == 0) return null;
		if (this.sourcemap_list.length == 1) return  this.sourcemap_list[0];
		return combine_sourcemaps(this.filename, this.sourcemap_list);
	}
}

type TagTarget = { tag_name: 'script' | 'style', offset: number, length: number, content: string, content_offset: number, attributes: string }

function find_target_tags(tag_name: 'script' | 'style', source: string): TagTarget[] {
	const instances:TagTarget[] = [];
	const regex = tag_name == 'script' 
		? /<!--[^]*?-->|<(script)(\s[^]*?)?(?:>([^]*?)<\/script>|\/>)/gi 
		: /<!--[^]*?-->|<(style)(\s[^]*?)?(?:>([^]*?)<\/style>|\/>)/gi;
	
	source.replace(regex, (match, matched_tag, attributes, content, offset) => {
		if (!matched_tag) return '';
		attributes = attributes || '';
		content = content || '',
		
		instances.push({
			tag_name: matched_tag,
			offset,
			length: match.length,
			content,
			content_offset: offset + `<${tag_name}${attributes}>`.length,
			attributes
		});

		return '';
	});

	return instances;
}

type ProcessedTag = { tag: TagTarget, processed: { code: string, dependencies: string[], map: RawSourceMap | DecodedSourceMap } }

async function preprocess_tag_content(filename: string, tag: TagTarget,  preprocessors: Preprocessor[]): Promise<ProcessedTag> {
	const target = new PreprocessorTarget(tag.content, filename);
	const attributes = parse_attributes(tag.attributes);
	
	for (const preprocessor of preprocessors) {
		target.applyPreprocessorOutput(await preprocessor({
			content: target.source,
			filename: target.filename,
			attributes
		}));
	}

	if (!target.was_processed) 
		{return null;}

	return {
		tag,
		processed: {
			code: target.source,
			dependencies: [...target.dependencies],
			map: target.getCombinedSourceMap()
		}
	};
}

function replace_tag_content(filename: string, source: string, processed_tags: ProcessedTag[]) {
	// build final content from start to end of markup, substituting our processed tags as we get to them
	processed_tags.sort((a,b) => a.tag.offset - b.tag.offset);

	const out = new StringWithSourcemap();
	const dependencies = [];
	let last_end = 0;
	const get_location = getLocator(source);
	for (const { tag, processed } of processed_tags) {
		const open_tag = `<${tag.tag_name}${tag.attributes}>`;
		const close_tag = `</${tag.tag_name}>`;
		
		// leading_markup = unchanged source characters before the replaced segment
		// we inject our own version of the opening and closing tags so that we can support self closing tags
		const leading_markup = StringWithSourcemap.from_source(filename, source.slice(last_end, tag.offset) + open_tag, get_location(last_end));
		const processed_tag_content = StringWithSourcemap.from_processed(processed.code, processed.map, get_location(tag.content_offset));
		const trailing_markup = StringWithSourcemap.from_source(filename, close_tag, get_location(tag.content_offset + tag.content.length - 1));

		out.concat(leading_markup).concat(processed_tag_content).concat(trailing_markup);

		last_end = tag.offset + tag.length;
		dependencies.push(...processed.dependencies);
	}
	// final_content = unchanged source characters after last replaced segment
	const final_content = StringWithSourcemap.from_source(filename, source.slice(last_end), get_location(last_end));
	
	const processed_content = out.concat(final_content);

	return {
		code: processed_content.string,
		map: processed_content.map,
		dependencies
	};
}

export default async function preprocess(
	source: string,
	preprocessor: PreprocessorGroup | PreprocessorGroup[],
	options?: { filename?: string }
) {
	// @ts-ignore todo: doublecheck
	const target = new PreprocessorTarget(source, (options && options.filename) || preprocessor.filename);

	const preprocessors = Array.isArray(preprocessor) ? preprocessor : [preprocessor || {}];
	const markup = preprocessors.map(p => p.markup).filter(Boolean);
	const script = preprocessors.map(p => p.script).filter(Boolean);
	const style = preprocessors.map(p => p.style).filter(Boolean);

	// process markup
	for (const fn of markup) {
		target.applyPreprocessorOutput(await fn({
			content: target.source,
			filename: target.filename
		}));
	}
	
	// extract and process script and style tags in parallel
	const tag_processors: Array<Promise<ProcessedTag>> = [];
	
	if (script.length) {
		const preprocessed_script_tags = find_target_tags('script', target.source).map(i => preprocess_tag_content(target.filename, i, script));
		tag_processors.push(...preprocessed_script_tags);
	}

	if (style.length) {
		const preprocessed_style_tags =  find_target_tags('style', target.source).map(i => preprocess_tag_content(target.filename, i, style));
		tag_processors.push(...preprocessed_style_tags);
	}

	const processed_tags = (await Promise.all(tag_processors)).filter(Boolean);

	// create the final output by inserting the processed tags into the processed markup
	if (processed_tags.length) {
		await target.applyPreprocessorOutput(replace_tag_content(target.filename, target.source, processed_tags));
	}
	
	return {
		// TODO return separated output, in future version where svelte.compile supports it:
		// style: { code: styleCode, map: styleMap },
		// script { code: scriptCode, map: scriptMap },
		// markup { code: markupCode, map: markupMap },
		code: target.source,
		map: target.getCombinedSourceMap(),
		dependencies: [...target.dependencies],
		toString() {
			return this.code;
		}
	};
}
