"""Provision only room-specific configuration. Secrets stay in environment/memory."""
import http.cookiejar
import json
import os
import urllib.parse
import urllib.request

QUERY = 'query { myOrg { itemTypes { ... on ItemTypeBase { id name } } mrtQueues { id name } routingRules { id name } actions { ... on ActionBase { id name } } } }'

def https_origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError('An exact HTTPS origin is required')
    return value

def provision(gql, origin, reviewers):
    https_origin(origin)
    if not reviewers or any(not isinstance(x, str) or not x for x in reviewers):
        raise ValueError('Explicit room reviewers are required')
    def state():
        value = gql(QUERY)['myOrg']
        if not value: raise ValueError('Organization unavailable')
        return value
    def ensure(collection, name, mutation, input_type, success, fields):
        existing = [x for x in state()[collection] if x['name'] == name]
        if len(existing) > 1: raise ValueError('Duplicate room configuration')
        if existing: return existing[0]['id']
        result = gql(f'mutation RoomSetup($input: {input_type}!) {{ {mutation}(input: $input) {{ __typename }} }}', {'input': dict(fields, name=name)})
        if result[mutation]['__typename'] != success: raise ValueError('Room configuration mutation rejected')
        return next(x['id'] for x in state()[collection] if x['name'] == name)
    fields = [{'name': 'case_id', 'type': 'STRING', 'required': True}, {'name': 'room', 'type': 'STRING', 'required': True}]
    member = ensure('itemTypes', 'concord_member', 'createUserItemType', 'CreateUserItemTypeInput', 'MutateUserTypeSuccessResponse', {'description': 'Reported community member. Actions affect this community only.', 'fields': fields, 'fieldRoles': {'displayName': 'room', 'createdAt': None, 'profileIcon': None, 'backgroundImage': None, 'isDeleted': None}})
    message = ensure('itemTypes', 'concord_message', 'createContentItemType', 'CreateContentItemTypeInput', 'MutateContentTypeSuccessResponse', {'description': 'Reported room message. Evidence is fetched on demand and expires at the enforcement service.', 'fields': fields + [{'name': 'author', 'type': 'RELATED_ITEM', 'required': True}], 'fieldRoles': {'displayName': 'room', 'creatorId': 'author', 'threadId': None, 'parentId': None, 'createdAt': None, 'isDeleted': None}})
    queue = ensure('mrtQueues', 'Room Review', 'createManualReviewQueue', 'CreateManualReviewQueueInput', 'MutateManualReviewQueueSuccessResponse', {'description': 'Public community reports; independent relay, Concord and Discord delivery status.', 'autoCloseJobs': False, 'isAppealsQueue': False, 'hiddenActionIds': [], 'userIds': reviewers})
    for item_type in [message, member]:
        ensure('routingRules', f'concord rooms {item_type} -> Room Review', 'createRoutingRule', 'CreateRoutingRuleInput', 'MutateRoutingRuleSuccessResponse', {'conditionSet': {'conditions': [], 'conjunction': 'AND'}, 'destinationQueueId': queue, 'itemTypeIds': [item_type], 'status': 'LIVE'})
    for name, description, types in [
        ('concord_remove_message', 'Remove this message from the community and Divine relay; delete mapped public Discord copies.', [message]),
        ('concord_ban_member', 'Ban in this community. Requires moderation manager. Does not ban the account platform-wide or from the Discord guild.', [message, member]),
        ('concord_unban_member', 'Remove this community ban. Does not restore removed content or alter platform-wide bans.', [message, member]),
    ]:
        ensure('actions', name, 'createAction', 'CreateActionInput', 'MutateActionSuccessResponse', {'description': description, 'itemTypeIds': types, 'callbackUrl': origin + '/v1/decisions'})
    return {'CONCORD_QUEUE_ID': queue, 'CONCORD_MESSAGE_TYPE_ID': message, 'CONCORD_MEMBER_TYPE_ID': member}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirects are not allowed during provisioning')

def main():
    origin = https_origin(os.environ['COOP_API_URL'])
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()), NoRedirect())
    def gql(query, variables=None):
        body = json.dumps({'query': query, 'variables': variables or {}}).encode()
        request = urllib.request.Request(origin + '/api/v1/graphql', data=body, headers={'Content-Type': 'application/json', 'Origin': origin})
        with opener.open(request, timeout=20) as response: result = json.load(response)
        if result.get('errors'): raise ValueError('GraphQL rejected room provisioning')
        return result['data']
    login = gql('mutation RoomLogin($input: LoginInput!) { login(input: $input) { __typename } }', {'input': {'email': os.environ['COOP_LOGIN_EMAIL'], 'password': os.environ['COOP_LOGIN_PASSWORD']}})
    if login['login']['__typename'] != 'LoginSuccessResponse': raise ValueError('Login failed')
    result = provision(gql, os.environ['CONCORD_MODERATION_ORIGIN'], json.loads(os.environ['CONCORD_REVIEWER_IDS']))
    for name, value in result.items(): print(f'{name}={value}')

if __name__ == '__main__':
    try: main()
    except Exception: raise SystemExit('Room provisioning failed. No credentials or response bodies have been logged.')
