import { BigInt, Bytes } from "@graphprotocol/graph-ts"
import {
  AddressRegistered,
  PositionsUpdated
} from "../generated/ClaimVote/ClaimVote"
import { Position, AddressRegistration } from "../generated/schema"

export function handleAddressRegistered(event: AddressRegistered): void {
  const id = event.params.publicKey.toHexString()
  let registration = AddressRegistration.load(id)
  
  if (!registration) {
    registration = new AddressRegistration(id)
    registration.publicKey = event.params.publicKey
    registration.ethAddress = event.params.ethAddress
    registration.timestamp = event.block.timestamp
    registration.save()
  }
}

export function handlePositionsUpdated(event: PositionsUpdated): void {
  const positions = event.params.positions
  const publicKey = event.params.publicKey
  
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]
    const id = publicKey.toHexString() + "-" + position.poolAddress.toHexString() + "-" + i.toString()
    
    let positionEntity = new Position(id)
    positionEntity.publicKey = publicKey
    positionEntity.poolAddress = position.poolAddress
    positionEntity.weight = position.weight
    positionEntity.timestamp = event.block.timestamp
    
    positionEntity.save()
  }
} 